import http from 'http';
import { URL } from 'url';

const todos = [];
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');

  if (pathname === '/todos' && method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify(todos));
  } else if (pathname === '/todos' && method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const todo = {
          id: nextId++,
          title: data.title,
          completed: data.completed || false
        };
        todos.push(todo);
        res.writeHead(201);
        res.end(JSON.stringify(todo));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (pathname.startsWith('/todos/') && method === 'PUT') {
    const id = parseInt(pathname.split('/')[2]);
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const todo = todos.find(t => t.id === id);
        if (!todo) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Todo not found' }));
          return;
        }
        if (data.title !== undefined) todo.title = data.title;
        if (data.completed !== undefined) todo.completed = data.completed;
        res.writeHead(200);
        res.end(JSON.stringify(todo));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (pathname.startsWith('/todos/') && method === 'DELETE') {
    const id = parseInt(pathname.split('/')[2]);
    const index = todos.findIndex(t => t.id === id);
    if (index === -1) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Todo not found' }));
      return;
    }
    const deleted = todos.splice(index, 1)[0];
    res.writeHead(200);
    res.end(JSON.stringify(deleted));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Todo API running on http://localhost:${PORT}`);
});
