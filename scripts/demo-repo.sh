#!/usr/bin/env bash
# Builds a throwaway repo with every kind of change lazyreview draws:
# modified (several hunks), staged, untracked, deleted, renamed, markdown,
# and a feature branch, so each base in `b` shows something different.
set -euo pipefail

DIR="${1:-$HOME/Workspace/mods/lazyreview-demo}"
rm -rf "$DIR"
mkdir -p "$DIR/src" "$DIR/docs"
cd "$DIR"
git init -q -b main
git config user.name "lazyreview demo"
git config user.email "demo@example.com"

# ── main: the starting project ─────────────────────────────────────────────

cat > package.json <<'EOF'
{
  "name": "todo-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/server.js" }
}
EOF

cat > README.md <<'EOF'
# todo-api

A tiny HTTP API for todos.

## Run

    npm start
EOF

cat > docs/ARCHITECTURE.md <<'EOF'
# Architecture

`server.js` routes requests to `todos.js`, which keeps todos in memory.
EOF

cat > src/server.js <<'EOF'
import http from 'node:http'
import { listTodos, addTodo, completeTodo } from './todos.js'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/todos') {
    return send(res, 200, listTodos())
  }
  if (req.method === 'POST' && url.pathname === '/todos') {
    const body = await readJson(req)
    return send(res, 201, addTodo(body.title))
  }
  if (req.method === 'POST' && url.pathname.startsWith('/todos/')) {
    const id = Number(url.pathname.split('/')[2])
    return send(res, 200, completeTodo(id))
  }
  send(res, 404, { error: 'not found' })
})

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  return JSON.parse(text)
}

server.listen(3000)
EOF

cat > src/todos.js <<'EOF'
// In-memory todo store.

const todos = []
let nextId = 1

export function listTodos() {
  return todos
}

export function addTodo(title) {
  const todo = { id: nextId++, title, done: false }
  todos.push(todo)
  return todo
}

export function completeTodo(id) {
  const todo = todos.find((t) => t.id === id)
  if (!todo) return null
  todo.done = true
  return todo
}

export function removeTodo(id) {
  const index = todos.findIndex((t) => t.id === id)
  if (index === -1) return false
  todos.splice(index, 1)
  return true
}

export function countOpen() {
  return todos.filter((t) => !t.done).length
}

export function clearDone() {
  for (let i = todos.length - 1; i >= 0; i--) {
    if (todos[i].done) todos.splice(i, 1)
  }
}
EOF

cat > src/utils.js <<'EOF'
export function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-')
}
EOF

cat > src/helpers.js <<'EOF'
export function formatDate(date) {
  return date.toISOString().slice(0, 10)
}
EOF

cat > src/legacy.js <<'EOF'
// Old v0 API, no longer routed.
export function oldList() {
  return []
}
EOF

git add . && git commit -qm "Initial todo API"

# ── feature branch: one commit already made ────────────────────────────────

git checkout -qb feature/due-dates

sed -i.bak 's/return send(res, 201, addTodo(body.title))/return send(res, 201, addTodo(body.title, body.due))/' src/server.js && rm src/server.js.bak
git commit -qam "Pass the due date through POST /todos"

# ── uncommitted work: what lazyreview reviews ──────────────────────────────

# Modified, two hunks far apart, with bugs for the AI review to find.
cat > src/todos.js <<'EOF'
// In-memory todo store, with due dates.

const todos = []
let nextId = 1

export function listTodos({ overdue = false } = {}) {
  if (!overdue) return todos
  const now = Date.now()
  return todos.filter((t) => t.due && new Date(t.due) < now)
}

export function addTodo(title, due) {
  const todo = { id: nextId++, title, done: false, due }
  todos.push(todo)
  return todo
}

export function completeTodo(id) {
  const todo = todos.find((t) => t.id === id)
  if (!todo) return null
  todo.done = true
  return todo
}

export function removeTodo(id) {
  const index = todos.findIndex((t) => t.id === id)
  if (index === -1) return false
  todos.splice(index, 1)
  return true
}

export function countOpen() {
  return todos.filter((t) => !t.done).length
}

export function clearDone() {
  for (let i = 0; i <= todos.length; i++) {
    if (todos[i].done) todos.splice(i, 1)
  }
}
EOF

# Staged change.
cat > src/utils.js <<'EOF'
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
}
EOF
git add src/utils.js

# Renamed (staged) and deleted.
git mv src/helpers.js src/format.js
git rm -q src/legacy.js

# Untracked new file with a security problem.
cat > src/auth.js <<'EOF'
const API_TOKEN = 'sk-live-1234567890abcdef'

export function isAuthorized(req) {
  return req.headers.authorization == 'Bearer ' + API_TOKEN
}
EOF

# Markdown noise, hidden by default.
cat >> README.md <<'EOF'

## Due dates

POST `/todos` with `{ "title": "...", "due": "2026-10-31" }`.
`GET /todos?overdue=true` lists overdue todos.
EOF

cat > docs/CHANGELOG.md <<'EOF'
# Changelog

## Unreleased

- Due dates on todos
- Overdue filter
- Token auth
EOF

# A big change (2,200 lines) and a lock file, to try paging and the generated-file gate.
for i in $(seq 0 2199); do
  echo "export function handler$i(req, res) { return res.json({ id: $i, name: 'item-$i', ok: true }) }"
done > src/routes.js
{
  echo '{ "name": "todo-api", "lockfileVersion": 3, "packages": {'
  for i in $(seq 0 899); do
    echo "  \"node_modules/pkg-$i\": { \"version\": \"1.$i.0\", \"resolved\": \"https://registry.npmjs.org/pkg-$i/-/pkg-$i-1.$i.0.tgz\" },"
  done
  echo '  "node_modules/last": { "version": "1.0.0" } } }'
} > package-lock.json

echo "Demo repo ready: $DIR"
git status --short
