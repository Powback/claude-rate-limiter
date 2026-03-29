import http from 'http';

// In-memory storage
const todos = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Set headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /todos
  if (pathname === '/todos' && method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify(Array.from(todos.values())));
    return;
  }

  // POST /todos
  if (pathname === '/todos' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const id = nextId++;
        const todo = { id, title: data.title, completed: false, ...data };
        todos.set(id, todo);
        res.writeHead(201);
        res.end(JSON.stringify(todo));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // PUT /todos/:id
  if (pathname.startsWith('/todos/') && method === 'PUT') {
    const id = parseInt(pathname.split('/')[2]);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!todos.has(id)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const existing = todos.get(id);
        const updated = { ...existing, ...data, id };
        todos.set(id, updated);
        res.writeHead(200);
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // DELETE /todos/:id
  if (pathname.startsWith('/todos/') && method === 'DELETE') {
    const id = parseInt(pathname.split('/')[2]);
    if (!todos.has(id)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    todos.delete(id);
    res.writeHead(204);
    res.end();
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`TODO API running on http://localhost:${PORT}`);
});
