class TodoList {
  constructor() {
    this.todos = [];
    this.nextId = 1;
  }

  add(text, priority = 'medium', dueDate = null) {
    const id = this.nextId++;
    this.todos.push({ id, text, completed: false, priority, dueDate });
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
    const todo = this.todos.find(todo => todo.id === id);
    if (todo) {
      todo.completed = true;
      return true;
    }
    return false;
  }

  filter(priority) {
    return this.todos.filter(todo => todo.priority === priority);
  }

  overdue() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.todos.filter(todo =>
      todo.dueDate &&
      new Date(todo.dueDate) < today &&
      !todo.completed
    );
  }

  list() {
    return this.todos;
  }

  stats() {
    const done = this.todos.filter(todo => todo.completed).length;
    const pending = this.todos.filter(todo => !todo.completed).length;
    const byPriority = {};

    this.todos.forEach(todo => {
      byPriority[todo.priority] = (byPriority[todo.priority] || 0) + 1;
    });

    return {
      total: this.todos.length,
      done,
      pending,
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
