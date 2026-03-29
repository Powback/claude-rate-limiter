class TodoList {
  constructor() {
    this.todos = [];
    this.nextId = 1;
  }

  add(text, priority = 'medium', dueDate = null) {
    if (!['low', 'medium', 'high'].includes(priority)) {
      priority = 'medium';
    }
    const id = this.nextId++;
    this.todos.push({ id, text, priority, dueDate });
    return id;
  }

  remove(id) {
    const index = this.todos.findIndex(todo => todo.id === id);
    if (index !== -1) {
      this.todos.splice(index, 1);
      return true;
    }
    return false;
  }

  complete(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.done = true;
      return true;
    }
    return false;
  }

  list() {
    return this.todos;
  }

  filter(priority) {
    return this.todos.filter(todo => todo.priority === priority);
  }

  overdue() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.todos.filter(todo =>
      todo.dueDate && new Date(todo.dueDate) < today && !todo.done
    );
  }

  stats() {
    const byPriority = { low: 0, medium: 0, high: 0 };
    let done = 0;

    this.todos.forEach(todo => {
      byPriority[todo.priority]++;
      if (todo.done) done++;
    });

    return {
      total: this.todos.length,
      done,
      pending: this.todos.length - done,
      byPriority
    };
  }

  toJSON() {
    return JSON.stringify({
      todos: this.todos,
      nextId: this.nextId
    });
  }

  static fromJSON(str) {
    const data = JSON.parse(str);
    const instance = new TodoList();
    instance.todos = data.todos;
    instance.nextId = data.nextId;
    return instance;
  }
}

module.exports = TodoList;
