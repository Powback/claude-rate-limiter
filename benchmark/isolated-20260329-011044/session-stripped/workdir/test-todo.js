const assert = require('assert');
const TodoList = require('./todo.js');

describe('TodoList', () => {
  let todoList;

  beforeEach(() => {
    todoList = new TodoList();
  });

  describe('constructor()', () => {
    it('should initialize with empty todos array', () => {
      assert.deepStrictEqual(todoList.todos, []);
    });

    it('should initialize nextId to 1', () => {
      assert.strictEqual(todoList.nextId, 1);
    });
  });

  describe('add()', () => {
    it('should add a todo with text and default priority', () => {
      const id = todoList.add('Buy groceries');
      assert.strictEqual(id, 1);
      assert.strictEqual(todoList.todos.length, 1);
      assert.deepStrictEqual(todoList.todos[0], {
        id: 1,
        text: 'Buy groceries',
        priority: 'medium',
        dueDate: null
      });
    });

    it('should add a todo with all parameters', () => {
      const id = todoList.add('Finish project', 'high', '2026-04-15');
      assert.strictEqual(id, 1);
      assert.deepStrictEqual(todoList.todos[0], {
        id: 1,
        text: 'Finish project',
        priority: 'high',
        dueDate: '2026-04-15'
      });
    });

    it('should support all valid priorities', () => {
      todoList.add('Low priority task', 'low');
      todoList.add('Medium priority task', 'medium');
      todoList.add('High priority task', 'high');

      assert.strictEqual(todoList.todos[0].priority, 'low');
      assert.strictEqual(todoList.todos[1].priority, 'medium');
      assert.strictEqual(todoList.todos[2].priority, 'high');
    });

    it('should default to medium priority for invalid priorities', () => {
      todoList.add('Task', 'invalid');
      todoList.add('Task', 'urgent');
      todoList.add('Task', '');

      assert.strictEqual(todoList.todos[0].priority, 'medium');
      assert.strictEqual(todoList.todos[1].priority, 'medium');
      assert.strictEqual(todoList.todos[2].priority, 'medium');
    });

    it('should increment id for each todo', () => {
      const id1 = todoList.add('First');
      const id2 = todoList.add('Second');
      const id3 = todoList.add('Third');

      assert.strictEqual(id1, 1);
      assert.strictEqual(id2, 2);
      assert.strictEqual(id3, 3);
    });

    it('should return the id of added todo', () => {
      const id = todoList.add('New task', 'high');
      assert.strictEqual(typeof id, 'number');
      assert.strictEqual(id, 1);
    });
  });

  describe('remove()', () => {
    it('should remove a todo by id', () => {
      const id = todoList.add('Task to remove');
      assert.strictEqual(todoList.todos.length, 1);

      const result = todoList.remove(id);
      assert.strictEqual(result, true);
      assert.strictEqual(todoList.todos.length, 0);
    });

    it('should return false when removing non-existent todo', () => {
      const result = todoList.remove(999);
      assert.strictEqual(result, false);
    });

    it('should remove correct todo when multiple exist', () => {
      const id1 = todoList.add('First');
      const id2 = todoList.add('Second');
      const id3 = todoList.add('Third');

      todoList.remove(id2);
      assert.strictEqual(todoList.todos.length, 2);
      assert.strictEqual(todoList.todos[0].id, id1);
      assert.strictEqual(todoList.todos[1].id, id3);
    });
  });

  describe('complete()', () => {
    it('should mark a todo as done', () => {
      const id = todoList.add('Task');
      const result = todoList.complete(id);

      assert.strictEqual(result, true);
      assert.strictEqual(todoList.todos[0].done, true);
    });

    it('should return false for non-existent todo', () => {
      const result = todoList.complete(999);
      assert.strictEqual(result, false);
    });

    it('should set done property to true', () => {
      const id = todoList.add('Task');
      assert.strictEqual(todoList.todos[0].done, undefined);

      todoList.complete(id);
      assert.strictEqual(todoList.todos[0].done, true);
    });

    it('should work on specific todo when multiple exist', () => {
      const id1 = todoList.add('First');
      const id2 = todoList.add('Second');
      const id3 = todoList.add('Third');

      todoList.complete(id2);
      assert.strictEqual(todoList.todos[0].done, undefined);
      assert.strictEqual(todoList.todos[1].done, true);
      assert.strictEqual(todoList.todos[2].done, undefined);
    });
  });

  describe('list()', () => {
    it('should return all todos', () => {
      todoList.add('First');
      todoList.add('Second');
      todoList.add('Third');

      const todos = todoList.list();
      assert.strictEqual(todos.length, 3);
      assert.strictEqual(todos[0].text, 'First');
      assert.strictEqual(todos[1].text, 'Second');
      assert.strictEqual(todos[2].text, 'Third');
    });

    it('should return empty array when no todos', () => {
      const todos = todoList.list();
      assert.deepStrictEqual(todos, []);
    });

    it('should return reference to todos array', () => {
      todoList.add('Task');
      const todos = todoList.list();
      assert.strictEqual(todos, todoList.todos);
    });
  });

  describe('filter()', () => {
    beforeEach(() => {
      todoList.add('Low priority task', 'low');
      todoList.add('Medium priority task 1', 'medium');
      todoList.add('High priority task 1', 'high');
      todoList.add('Medium priority task 2', 'medium');
      todoList.add('High priority task 2', 'high');
    });

    it('should filter todos by low priority', () => {
      const filtered = todoList.filter('low');
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].priority, 'low');
    });

    it('should filter todos by medium priority', () => {
      const filtered = todoList.filter('medium');
      assert.strictEqual(filtered.length, 2);
      assert.deepStrictEqual(filtered.map(t => t.text), [
        'Medium priority task 1',
        'Medium priority task 2'
      ]);
    });

    it('should filter todos by high priority', () => {
      const filtered = todoList.filter('high');
      assert.strictEqual(filtered.length, 2);
      assert.deepStrictEqual(filtered.map(t => t.text), [
        'High priority task 1',
        'High priority task 2'
      ]);
    });

    it('should return empty array for non-existent priority', () => {
      const filtered = todoList.filter('invalid');
      assert.deepStrictEqual(filtered, []);
    });

    it('should return empty array when no todos match', () => {
      const newList = new TodoList();
      newList.add('Task', 'high');
      const filtered = newList.filter('low');
      assert.deepStrictEqual(filtered, []);
    });
  });

  describe('overdue()', () => {
    it('should return todos with past due dates', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      todoList.add('Overdue task', 'high', yesterdayStr);
      const overdue = todoList.overdue();

      assert.strictEqual(overdue.length, 1);
      assert.strictEqual(overdue[0].text, 'Overdue task');
    });

    it('should not include completed overdue todos', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const id = todoList.add('Completed overdue task', 'high', yesterdayStr);
      todoList.complete(id);
      const overdue = todoList.overdue();

      assert.strictEqual(overdue.length, 0);
    });

    it('should not include todos with future due dates', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      todoList.add('Future task', 'high', tomorrowStr);
      const overdue = todoList.overdue();

      assert.strictEqual(overdue.length, 0);
    });

    it('should not include todos without due dates', () => {
      todoList.add('No due date task');
      const overdue = todoList.overdue();

      assert.strictEqual(overdue.length, 0);
    });

    it('should return empty array when no overdue todos', () => {
      todoList.add('Future task', 'high', '2099-12-31');
      todoList.add('No date task', 'medium');
      const overdue = todoList.overdue();

      assert.deepStrictEqual(overdue, []);
    });

    it('should handle multiple overdue todos', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      todoList.add('Overdue 1', 'high', yesterdayStr);
      todoList.add('Overdue 2', 'medium', twoDaysAgoStr);
      todoList.add('Future', 'low', '2099-12-31');

      const overdue = todoList.overdue();
      assert.strictEqual(overdue.length, 2);
    });
  });

  describe('stats()', () => {
    it('should return correct stats for empty list', () => {
      const stats = todoList.stats();

      assert.deepStrictEqual(stats, {
        total: 0,
        done: 0,
        pending: 0,
        byPriority: { low: 0, medium: 0, high: 0 }
      });
    });

    it('should count total todos', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');

      const stats = todoList.stats();
      assert.strictEqual(stats.total, 3);
    });

    it('should count completed todos', () => {
      const id1 = todoList.add('Task 1');
      const id2 = todoList.add('Task 2');
      todoList.add('Task 3');

      todoList.complete(id1);
      todoList.complete(id2);

      const stats = todoList.stats();
      assert.strictEqual(stats.done, 2);
    });

    it('should calculate pending todos', () => {
      const id1 = todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');

      todoList.complete(id1);

      const stats = todoList.stats();
      assert.strictEqual(stats.pending, 2);
    });

    it('should count todos by priority', () => {
      todoList.add('Low 1', 'low');
      todoList.add('Low 2', 'low');
      todoList.add('Medium 1', 'medium');
      todoList.add('High 1', 'high');
      todoList.add('High 2', 'high');
      todoList.add('High 3', 'high');

      const stats = todoList.stats();
      assert.deepStrictEqual(stats.byPriority, {
        low: 2,
        medium: 1,
        high: 3
      });
    });

    it('should update stats after adding todos', () => {
      let stats = todoList.stats();
      assert.strictEqual(stats.total, 0);

      todoList.add('Task 1', 'high');
      stats = todoList.stats();
      assert.strictEqual(stats.total, 1);
      assert.strictEqual(stats.byPriority.high, 1);
    });

    it('should update stats after removing todos', () => {
      const id = todoList.add('Task 1', 'high');
      let stats = todoList.stats();
      assert.strictEqual(stats.total, 1);

      todoList.remove(id);
      stats = todoList.stats();
      assert.strictEqual(stats.total, 0);
    });

    it('should update stats after completing todos', () => {
      const id = todoList.add('Task 1');
      let stats = todoList.stats();
      assert.strictEqual(stats.done, 0);
      assert.strictEqual(stats.pending, 1);

      todoList.complete(id);
      stats = todoList.stats();
      assert.strictEqual(stats.done, 1);
      assert.strictEqual(stats.pending, 0);
    });
  });

  describe('toJSON()', () => {
    it('should serialize empty todo list', () => {
      const json = todoList.toJSON();
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, {
        todos: [],
        nextId: 1
      });
    });

    it('should serialize todos with all properties', () => {
      todoList.add('Task 1', 'high', '2026-04-15');
      todoList.add('Task 2', 'low');

      const json = todoList.toJSON();
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.todos.length, 2);
      assert.strictEqual(parsed.todos[0].text, 'Task 1');
      assert.strictEqual(parsed.todos[0].priority, 'high');
      assert.strictEqual(parsed.todos[0].dueDate, '2026-04-15');
      assert.strictEqual(parsed.nextId, 3);
    });

    it('should include done property in serialization', () => {
      const id = todoList.add('Task 1');
      todoList.complete(id);

      const json = todoList.toJSON();
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.todos[0].done, true);
    });

    it('should return valid JSON string', () => {
      todoList.add('Task');
      const json = todoList.toJSON();

      assert.strictEqual(typeof json, 'string');
      assert.doesNotThrow(() => {
        JSON.parse(json);
      });
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize empty todo list', () => {
      const json = JSON.stringify({
        todos: [],
        nextId: 1
      });

      const restored = TodoList.fromJSON(json);
      assert.deepStrictEqual(restored.todos, []);
      assert.strictEqual(restored.nextId, 1);
    });

    it('should deserialize todos with all properties', () => {
      const originalJson = JSON.stringify({
        todos: [
          { id: 1, text: 'Task 1', priority: 'high', dueDate: '2026-04-15' },
          { id: 2, text: 'Task 2', priority: 'low', dueDate: null }
        ],
        nextId: 3
      });

      const restored = TodoList.fromJSON(originalJson);
      assert.strictEqual(restored.todos.length, 2);
      assert.strictEqual(restored.todos[0].text, 'Task 1');
      assert.strictEqual(restored.todos[1].text, 'Task 2');
      assert.strictEqual(restored.nextId, 3);
    });

    it('should restore done property', () => {
      const json = JSON.stringify({
        todos: [
          { id: 1, text: 'Task 1', priority: 'high', dueDate: null, done: true },
          { id: 2, text: 'Task 2', priority: 'medium', dueDate: null, done: false }
        ],
        nextId: 3
      });

      const restored = TodoList.fromJSON(json);
      assert.strictEqual(restored.todos[0].done, true);
      assert.strictEqual(restored.todos[1].done, false);
    });

    it('should return a TodoList instance', () => {
      const json = JSON.stringify({ todos: [], nextId: 1 });
      const restored = TodoList.fromJSON(json);

      assert(restored instanceof TodoList);
    });

    it('should allow operations on restored list', () => {
      const originalJson = JSON.stringify({
        todos: [{ id: 1, text: 'Task 1', priority: 'high', dueDate: null }],
        nextId: 2
      });

      const restored = TodoList.fromJSON(originalJson);
      const newId = restored.add('Task 2');

      assert.strictEqual(newId, 2);
      assert.strictEqual(restored.todos.length, 2);
    });

    it('should round-trip: toJSON then fromJSON', () => {
      todoList.add('Task 1', 'high', '2026-04-15');
      const id2 = todoList.add('Task 2', 'low');
      todoList.complete(id2);

      const json = todoList.toJSON();
      const restored = TodoList.fromJSON(json);

      assert.deepStrictEqual(restored.todos, todoList.todos);
      assert.strictEqual(restored.nextId, todoList.nextId);
    });
  });

  describe('integration tests', () => {
    it('should handle complete workflow', () => {
      // Add todos
      const id1 = todoList.add('Learn JavaScript', 'high');
      const id2 = todoList.add('Build a project', 'high');
      const id3 = todoList.add('Write tests', 'medium');
      const id4 = todoList.add('Deploy app', 'high');

      // Check initial stats
      let stats = todoList.stats();
      assert.strictEqual(stats.total, 4);
      assert.strictEqual(stats.byPriority.high, 3);

      // Complete some tasks
      todoList.complete(id1);
      todoList.complete(id3);

      // Check updated stats
      stats = todoList.stats();
      assert.strictEqual(stats.done, 2);
      assert.strictEqual(stats.pending, 2);

      // Filter by priority
      const highPriority = todoList.filter('high');
      assert.strictEqual(highPriority.length, 3);

      // Remove a todo
      todoList.remove(id4);
      assert.strictEqual(todoList.list().length, 3);

      // Serialize and deserialize
      const json = todoList.toJSON();
      const restored = TodoList.fromJSON(json);
      assert.deepStrictEqual(restored.list(), todoList.list());
    });

    it('should handle todos with past, present, and future dates', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      todoList.add('Overdue', 'high', yesterdayStr);
      todoList.add('Due today', 'medium', todayStr);
      todoList.add('Due tomorrow', 'low', tomorrowStr);

      const overdue = todoList.overdue();
      assert.strictEqual(overdue.length, 1);
      assert.strictEqual(overdue[0].text, 'Overdue');
    });
  });
});
