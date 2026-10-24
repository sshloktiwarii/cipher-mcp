package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var conventionalCommitRegex = regexp.MustCompile(`(?i)^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?!?: .+`)

type MCPTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
}

type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type JSONRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   interface{} `json:"error,omitempty"`
}

type MCPServer struct {
	db *sql.DB
}

func NewMCPServer(dbPath string) (*MCPServer, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("failed to open SQLite: %w", err)
	}

	schema := `
	CREATE TABLE IF NOT EXISTS pending_actions (
		id TEXT PRIMARY KEY,
		repo_path TEXT NOT NULL,
		branch TEXT NOT NULL,
		message TEXT NOT NULL,
		files TEXT NOT NULL,
		status TEXT NOT NULL,
		commit_sha TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	`
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("failed to init schema: %w", err)
	}

	return &MCPServer{db: db}, nil
}

func (s *MCPServer) handleGitStatus(repoPath string, includeDiff bool) (map[string]interface{}, error) {
	if repoPath == "" {
		var err error
		repoPath, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}

	cmdStatus := exec.Command("git", "status", "--porcelain", "-b")
	cmdStatus.Dir = repoPath
	statusOut, err := cmdStatus.Output()
	if err != nil {
		return nil, fmt.Errorf("git status error: %v", err)
	}

	res := map[string]interface{}{
		"repo_path": repoPath,
		"status":    string(statusOut),
	}

	if includeDiff {
		cmdDiff := exec.Command("git", "diff", "HEAD")
		cmdDiff.Dir = repoPath
		diffOut, _ := cmdDiff.Output()
		res["diff"] = string(diffOut)
	}
	return res, nil
}

func (s *MCPServer) handleGitCommit(repoPath, message string, files []string) (map[string]interface{}, error) {
	if message == "" {
		return nil, errors.New("commit message is required")
	}
	if !conventionalCommitRegex.MatchString(message) {
		return nil, errors.New("message violates Conventional Commits schema")
	}

	if repoPath == "" {
		repoPath, _ = os.Getwd()
	}

	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	actionID := "act-" + hex.EncodeToString(idBytes)

	now := time.Now().UTC().Format(time.RFC3339)
	filesJSON, _ := json.Marshal(files)

	_, err := s.db.Exec(`
		INSERT INTO pending_actions (id, repo_path, branch, message, files, status, created_at, updated_at)
		VALUES (?, ?, 'master', ?, ?, 'pending', ?, ?)
	`, actionID, repoPath, message, string(filesJSON), now, now)

	if err != nil {
		return nil, fmt.Errorf("failed to queue HITL action: %w", err)
	}

	return map[string]interface{}{
		"action_id":  actionID,
		"status":     "queued_for_hitl_approval",
		"message":    message,
		"queued_at":  now,
		"resolution": fmt.Sprintf("Approve via POST /approve with {'action_id': '%s'}", actionID),
	}, nil
}

func (s *MCPServer) listPendingActions() ([]map[string]interface{}, error) {
	rows, err := s.db.Query(`SELECT id, repo_path, branch, message, files, status, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var actions []map[string]interface{}
	for rows.Next() {
		var id, repo, branch, msg, files, status, createdAt string
		if err := rows.Scan(&id, &repo, &branch, &msg, &files, &status, &createdAt); err == nil {
			actions = append(actions, map[string]interface{}{
				"id":         id,
				"repo_path":  repo,
				"branch":     branch,
				"message":    msg,
				"files":      files,
				"status":     status,
				"created_at": createdAt,
			})
		}
	}
	return actions, nil
}

func (s *MCPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	switch {
	case r.URL.Path == "/health" || r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"service":   "cipher-mcp",
			"status":    "healthy",
			"runtime":   "native-go-mcp",
			"protocol":  "modelcontextprotocol/2.0",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		})

	case r.URL.Path == "/tools":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.getToolDefinitions())

	case r.URL.Path == "/pending":
		actions, err := s.listPendingActions()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"pending_actions": actions})

	case r.URL.Path == "/mcp" || r.URL.Path == "/":
		s.handleJSONRPC(w, r)

	default:
		http.NotFound(w, r)
	}
}

func (s *MCPServer) getToolDefinitions() []MCPTool {
	return []MCPTool{
		{
			Name:        "git_status",
			Description: "Reads local git status, branch, modified files, and unified git diff.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"repo_path":    map[string]string{"type": "string", "description": "Path to git repository root"},
					"include_diff": map[string]string{"type": "boolean", "description": "Include unified diff (default true)"},
				},
			},
		},
		{
			Name:        "git_commit",
			Description: "Queues a Conventional Commit into the Human-in-the-Loop (HITL) approval database for human review.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"repo_path": map[string]string{"type": "string", "description": "Target git repository path"},
					"message":   map[string]string{"type": "string", "description": "Conventional commit message"},
					"files":     map[string]interface{}{"type": "array", "items": map[string]string{"type": "string"}},
				},
				"required": []string{"message"},
			},
		},
		{
			Name:        "list_pending_actions",
			Description: "Lists all pending git commit actions awaiting human-in-the-loop sign-off.",
			InputSchema: map[string]interface{}{"type": "object"},
		},
	}
}

func (s *MCPServer) handleJSONRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5*1024*1024))
	if err != nil {
		http.Error(w, `{"error":"Body too large"}`, http.StatusBadRequest)
		return
	}

	var req JSONRPCRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"Malformed JSON-RPC request"}`, http.StatusBadRequest)
		return
	}

	resp := JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
	}

	switch req.Method {
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"tools": map[string]interface{}{},
			},
			"serverInfo": map[string]string{
				"name":    "cipher-mcp-go",
				"version": "2.0.0",
			},
		}

	case "tools/list":
		resp.Result = map[string]interface{}{
			"tools": s.getToolDefinitions(),
		}

	case "tools/call":
		var callParams struct {
			Name      string                 `json:"name"`
			Arguments map[string]interface{} `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &callParams)

		switch callParams.Name {
		case "git_status":
			repoPath, _ := callParams.Arguments["repo_path"].(string)
			includeDiff := true
			if val, ok := callParams.Arguments["include_diff"].(bool); ok {
				includeDiff = val
			}
			res, err := s.handleGitStatus(repoPath, includeDiff)
			if err != nil {
				resp.Error = map[string]interface{}{"code": -32603, "message": err.Error()}
			} else {
				resp.Result = map[string]interface{}{"content": []map[string]interface{}{{"type": "text", "text": fmt.Sprintf("%v", res)}}}
			}

		case "git_commit":
			repoPath, _ := callParams.Arguments["repo_path"].(string)
			msg, _ := callParams.Arguments["message"].(string)
			res, err := s.handleGitCommit(repoPath, msg, nil)
			if err != nil {
				resp.Error = map[string]interface{}{"code": -32602, "message": err.Error()}
			} else {
				resp.Result = map[string]interface{}{"content": []map[string]interface{}{{"type": "text", "text": fmt.Sprintf("%v", res)}}}
			}

		case "list_pending_actions":
			actions, err := s.listPendingActions()
			if err != nil {
				resp.Error = map[string]interface{}{"code": -32603, "message": err.Error()}
			} else {
				resp.Result = map[string]interface{}{"content": []map[string]interface{}{{"type": "text", "text": fmt.Sprintf("%v", actions)}}}
			}

		default:
			resp.Error = map[string]interface{}{"code": -32601, "message": "Method not found"}
		}

	default:
		resp.Error = map[string]interface{}{"code": -32601, "message": "Unsupported method: " + req.Method}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func main() {
	port := flag.String("port", "8085", "MCP HTTP listen port")
	socket := flag.String("socket", "/tmp/cipher/mcp.sock", "Unix domain socket path")
	dbPath := flag.String("db", "./pending_actions.db", "SQLite database path")
	flag.Parse()

	server, err := NewMCPServer(*dbPath)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize MCP Server: %v", err)
	}

	httpServer := &http.Server{
		Addr:         ":" + *port,
		Handler:      server,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	// 1. Bind Unix domain socket with 0600 permissions
	if *socket != "" {
		_ = os.MkdirAll(filepath.Dir(*socket), 0755)
		_ = os.Remove(*socket)
		unixListener, err := net.Listen("unix", *socket)
		if err == nil {
			_ = os.Chmod(*socket, 0600)
			go func() {
				log.Printf("[INIT] Cipher-MCP listening on Unix Domain Socket %s (permissions: 0600)", *socket)
				_ = httpServer.Serve(unixListener)
			}()
		} else {
			log.Printf("[WARN] Failed to bind unix domain socket: %v", err)
		}
	}

	// 2. Bind TCP port
	go func() {
		log.Printf("[INIT] Cipher-MCP listening on :%s (Native Go MCP Protocol 2.0)", *port)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[FATAL] Server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("[SHUTDOWN] Exiting Cipher-MCP...")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
