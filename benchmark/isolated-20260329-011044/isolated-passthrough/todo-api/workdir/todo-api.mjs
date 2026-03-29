import http from 'http';
import url from 'url';

const todos = new Map();
let nextId = 1;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Set CORS headers
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

  // Helper to read body
  const readBody = () => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  };

  try {
    // GET /todos
    if (method === 'GET' && pathname === '/todos') {
      const todoList = Array.from(todos.values());
      res.writeHead(200);
      res.end(JSON.stringify(todoList));
      return;
    }

    // POST /todos
    if (method === 'POST' && pathname === '/todos') {
      const body = await readBody();
      if (!body.title) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing required field: title' }));
        return;
      }
      const id = nextId++;
      const todo = {
        id,
        title: body.title,
        completed: body.completed || false,
        createdAt: new Date().toISOString()
      };
      todos.set(id, todo);
      res.writeHead(201);
      res.end(JSON.stringify(todo));
      return;
    }

    // PUT /todos/:id
    if (method === 'PUT' && pathname.startsWith('/todos/')) {
      const id = parseInt(pathname.split('/')[2]);
      if (!todos.has(id)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Todo not found' }));
        return;
      }
      const body = await readBody();
      const todo = todos.get(id);
      if (body.title !== undefined) todo.title = body.title;
      if (body.completed !== undefined) todo.completed = body.completed;
      todos.set(id, todo);
      res.writeHead(200);
      res.end(JSON.stringify(todo));
      return;
    }

    // DELETE /todos/:id
    if (method === 'DELETE' && pathname.startsWith('/todos/')) {
      const id = parseInt(pathname.split('/')[2]);
      if (!todos.has(id)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Todo not found' }));
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
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Todo API running on http://localhost:${PORT}`);
});
