const TodoList = require('./todo');

describe('TodoList', () => {
  let todoList;

  beforeEach(() => {
    todoList = new TodoList();
  });

  describe('constructor', () => {
    it('should initialize with empty todos array', () => {
      expect(todoList.todos).toEqual([]);
    });

    it('should initialize nextId to 1', () => {
      expect(todoList.nextId).toBe(1);
    });
  });

  describe('add()', () => {
    it('should add a todo with default priority', () => {
      const id = todoList.add('Buy groceries');
      expect(id).toBe(1);
      expect(todoList.todos).toHaveLength(1);
      expect(todoList.todos[0]).toEqual({
        id: 1,
        text: 'Buy groceries',
        completed: false,
        priority: 'medium',
        dueDate: null
      });
    });

    it('should add a todo with custom priority', () => {
      const id = todoList.add('Fix bug', 'high');
      expect(todoList.todos[0].priority).toBe('high');
    });

    it('should add a todo with due date', () => {
      const dueDate = '2026-03-30';
      const id = todoList.add('Meeting', 'high', dueDate);
      expect(todoList.todos[0].dueDate).toBe(dueDate);
    });

    it('should increment nextId for each addition', () => {
      const id1 = todoList.add('Task 1');
      const id2 = todoList.add('Task 2');
      const id3 = todoList.add('Task 3');
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('should return the correct id', () => {
      const id = todoList.add('Test');
      expect(id).toBe(todoList.todos[0].id);
    });

    it('should add multiple todos correctly', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      expect(todoList.todos).toHaveLength(3);
    });

    it('should mark todos as not completed when added', () => {
      todoList.add('Task');
      expect(todoList.todos[0].completed).toBe(false);
    });
  });

  describe('remove()', () => {
    beforeEach(() => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
    });

    it('should remove a todo by id', () => {
      const result = todoList.remove(2);
      expect(result).toBe(true);
      expect(todoList.todos).toHaveLength(2);
      expect(todoList.todos.some(t => t.id === 2)).toBe(false);
    });

    it('should return false when removing non-existent id', () => {
      const result = todoList.remove(999);
      expect(result).toBe(false);
    });

    it('should not modify array when removing non-existent id', () => {
      const originalLength = todoList.todos.length;
      todoList.remove(999);
      expect(todoList.todos).toHaveLength(originalLength);
    });

    it('should remove the first todo', () => {
      todoList.remove(1);
      expect(todoList.todos[0].id).toBe(2);
    });

    it('should remove the last todo', () => {
      todoList.remove(3);
      expect(todoList.todos[todoList.todos.length - 1].id).toBe(2);
    });

    it('should remove the middle todo', () => {
      todoList.remove(2);
      expect(todoList.todos.map(t => t.id)).toEqual([1, 3]);
    });

    it('should return true when successfully removing', () => {
      const result = todoList.remove(1);
      expect(result).toBe(true);
    });
  });

  describe('complete()', () => {
    beforeEach(() => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
    });

    it('should mark a todo as completed', () => {
      const result = todoList.complete(1);
      expect(result).toBe(true);
      expect(todoList.todos[0].completed).toBe(true);
    });

    it('should return true when completing existing todo', () => {
      const result = todoList.complete(1);
      expect(result).toBe(true);
    });

    it('should return false when completing non-existent todo', () => {
      const result = todoList.complete(999);
      expect(result).toBe(false);
    });

    it('should not modify array when completing non-existent todo', () => {
      const originalLength = todoList.todos.length;
      todoList.complete(999);
      expect(todoList.todos).toHaveLength(originalLength);
    });

    it('should only mark the correct todo as completed', () => {
      todoList.complete(2);
      expect(todoList.todos[0].completed).toBe(false);
      expect(todoList.todos[1].completed).toBe(true);
      expect(todoList.todos[2].completed).toBe(false);
    });

    it('should handle completing multiple todos', () => {
      todoList.complete(1);
      todoList.complete(3);
      expect(todoList.todos[0].completed).toBe(true);
      expect(todoList.todos[1].completed).toBe(false);
      expect(todoList.todos[2].completed).toBe(true);
    });

    it('should be idempotent (completing twice should work)', () => {
      todoList.complete(1);
      const result = todoList.complete(1);
      expect(result).toBe(true);
      expect(todoList.todos[0].completed).toBe(true);
    });
  });

  describe('filter()', () => {
    beforeEach(() => {
      todoList.add('High priority task 1', 'high');
      todoList.add('Medium priority task', 'medium');
      todoList.add('High priority task 2', 'high');
      todoList.add('Low priority task', 'low');
    });

    it('should filter todos by priority', () => {
      const highPriority = todoList.filter('high');
      expect(highPriority).toHaveLength(2);
      expect(highPriority.every(t => t.priority === 'high')).toBe(true);
    });

    it('should return empty array for non-existent priority', () => {
      const filtered = todoList.filter('urgent');
      expect(filtered).toEqual([]);
    });

    it('should return original objects, not copies', () => {
      const filtered = todoList.filter('high');
      expect(filtered[0]).toBe(todoList.todos[0]);
    });

    it('should filter medium priority', () => {
      const mediumPriority = todoList.filter('medium');
      expect(mediumPriority).toHaveLength(1);
      expect(mediumPriority[0].text).toBe('Medium priority task');
    });

    it('should filter low priority', () => {
      const lowPriority = todoList.filter('low');
      expect(lowPriority).toHaveLength(1);
      expect(lowPriority[0].priority).toBe('low');
    });

    it('should not modify original todos array', () => {
      const originalLength = todoList.todos.length;
      todoList.filter('high');
      expect(todoList.todos).toHaveLength(originalLength);
    });
  });

  describe('overdue()', () => {
    it('should return empty array when no todos have due dates', () => {
      todoList.add('Task without due date');
      const overdue = todoList.overdue();
      expect(overdue).toEqual([]);
    });

    it('should return empty array when all todos are completed', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      todoList.add('Completed overdue task', 'high', yesterday.toISOString().split('T')[0]);
      todoList.complete(1);
      const overdue = todoList.overdue();
      expect(overdue).toEqual([]);
    });

    it('should identify overdue incomplete todos', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      todoList.add('Overdue task', 'high', yesterdayStr);
      const overdue = todoList.overdue();
      expect(overdue).toHaveLength(1);
      expect(overdue[0].id).toBe(1);
    });

    it('should not include todos due today', () => {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      todoList.add('Due today', 'high', todayStr);
      const overdue = todoList.overdue();
      expect(overdue).toHaveLength(0);
    });

    it('should not include todos due in the future', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      todoList.add('Due tomorrow', 'high', tomorrowStr);
      const overdue = todoList.overdue();
      expect(overdue).toHaveLength(0);
    });

    it('should not include completed overdue todos', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      todoList.add('Completed overdue', 'high', yesterdayStr);
      todoList.complete(1);
      const overdue = todoList.overdue();
      expect(overdue).toHaveLength(0);
    });

    it('should handle multiple overdue todos', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

      todoList.add('Overdue 1', 'high', yesterdayStr);
      todoList.add('Overdue 2', 'high', twoDaysAgoStr);
      todoList.add('Not overdue', 'high');

      const overdue = todoList.overdue();
      expect(overdue).toHaveLength(2);
    });
  });

  describe('list()', () => {
    it('should return empty array when no todos', () => {
      const list = todoList.list();
      expect(list).toEqual([]);
    });

    it('should return all todos', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      const list = todoList.list();
      expect(list).toHaveLength(3);
    });

    it('should return todos in order of addition', () => {
      todoList.add('First');
      todoList.add('Second');
      todoList.add('Third');
      const list = todoList.list();
      expect(list[0].text).toBe('First');
      expect(list[1].text).toBe('Second');
      expect(list[2].text).toBe('Third');
    });

    it('should return the actual todos array', () => {
      todoList.add('Task');
      const list = todoList.list();
      expect(list).toBe(todoList.todos);
    });

    it('should reflect changes to todos', () => {
      todoList.add('Task');
      todoList.complete(1);
      const list = todoList.list();
      expect(list[0].completed).toBe(true);
    });
  });

  describe('stats()', () => {
    it('should return correct stats for empty list', () => {
      const stats = todoList.stats();
      expect(stats).toEqual({
        total: 0,
        done: 0,
        pending: 0,
        byPriority: {}
      });
    });

    it('should count total todos', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      const stats = todoList.stats();
      expect(stats.total).toBe(3);
    });

    it('should count completed todos', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      todoList.complete(1);
      todoList.complete(3);
      const stats = todoList.stats();
      expect(stats.done).toBe(2);
    });

    it('should count pending todos', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      todoList.complete(1);
      const stats = todoList.stats();
      expect(stats.pending).toBe(2);
    });

    it('should count todos by priority', () => {
      todoList.add('Task 1', 'high');
      todoList.add('Task 2', 'high');
      todoList.add('Task 3', 'medium');
      todoList.add('Task 4', 'low');
      const stats = todoList.stats();
      expect(stats.byPriority).toEqual({
        high: 2,
        medium: 1,
        low: 1
      });
    });

    it('should have total equal to done + pending', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.add('Task 3');
      todoList.complete(1);
      todoList.complete(2);
      const stats = todoList.stats();
      expect(stats.total).toBe(stats.done + stats.pending);
    });

    it('should return correct stats with all properties', () => {
      todoList.add('High 1', 'high');
      todoList.add('High 2', 'high');
      todoList.add('Medium', 'medium');
      todoList.complete(1);
      const stats = todoList.stats();
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('done');
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('byPriority');
      expect(stats.total).toBe(3);
      expect(stats.done).toBe(1);
      expect(stats.pending).toBe(2);
    });
  });

  describe('toJSON() and fromJSON()', () => {
    it('should serialize an empty TodoList', () => {
      const json = todoList.toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.todos).toEqual([]);
      expect(parsed.nextId).toBe(1);
    });

    it('should serialize todos with all properties', () => {
      todoList.add('Task 1', 'high', '2026-03-30');
      todoList.complete(1);
      const json = todoList.toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.todos[0]).toEqual({
        id: 1,
        text: 'Task 1',
        completed: true,
        priority: 'high',
        dueDate: '2026-03-30'
      });
    });

    it('should preserve nextId in serialization', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      todoList.remove(1);
      todoList.add('Task 3');
      const json = todoList.toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.nextId).toBe(4);
    });

    it('should deserialize a TodoList from JSON', () => {
      todoList.add('Task 1', 'high');
      todoList.add('Task 2', 'low');
      todoList.complete(1);
      const json = todoList.toJSON();

      const restored = TodoList.fromJSON(json);
      expect(restored.todos).toHaveLength(2);
      expect(restored.todos[0].completed).toBe(true);
      expect(restored.todos[1].priority).toBe('low');
    });

    it('should restore nextId correctly', () => {
      todoList.add('Task 1');
      todoList.add('Task 2');
      const json = todoList.toJSON();

      const restored = TodoList.fromJSON(json);
      expect(restored.nextId).toBe(3);
      const newId = restored.add('Task 3');
      expect(newId).toBe(3);
    });

    it('should be able to serialize and deserialize multiple times', () => {
      todoList.add('Task 1', 'high');
      const json1 = todoList.toJSON();
      const restored1 = TodoList.fromJSON(json1);
      const json2 = restored1.toJSON();
      const restored2 = TodoList.fromJSON(json2);

      expect(restored2.todos).toEqual(todoList.todos);
      expect(restored2.nextId).toBe(todoList.nextId);
    });

    it('should handle complex state with mixed todos', () => {
      todoList.add('Task 1', 'high', '2026-03-30');
      todoList.add('Task 2', 'medium');
      todoList.add('Task 3', 'low', '2026-04-01');
      todoList.complete(1);
      todoList.remove(2);
      const json = todoList.toJSON();

      const restored = TodoList.fromJSON(json);
      expect(restored.todos).toHaveLength(2);
      expect(restored.todos[0].completed).toBe(true);
      expect(restored.todos[1].id).toBe(3);
    });

    it('should throw on invalid JSON', () => {
      expect(() => TodoList.fromJSON('invalid json')).toThrow();
    });
  });

  describe('integration tests', () => {
    it('should handle a complete workflow', () => {
      const id1 = todoList.add('Buy groceries', 'medium');
      const id2 = todoList.add('Fix bug', 'high');
      const id3 = todoList.add('Write docs', 'low');

      todoList.complete(id1);
      expect(todoList.list()).toHaveLength(3);

      const highPriority = todoList.filter('high');
      expect(highPriority).toHaveLength(1);

      const stats = todoList.stats();
      expect(stats.done).toBe(1);
      expect(stats.pending).toBe(2);
      expect(stats.byPriority.high).toBe(1);
    });

    it('should maintain consistency across operations', () => {
      todoList.add('Task 1', 'high');
      todoList.add('Task 2', 'medium');
      todoList.add('Task 3', 'low');
      todoList.complete(1);
      todoList.remove(3);

      const stats = todoList.stats();
      expect(stats.total).toBe(2);
      expect(stats.done).toBe(1);
      expect(stats.pending).toBe(1);
      expect(Object.values(stats.byPriority).reduce((a, b) => a + b, 0)).toBe(2);
    });

    it('should preserve state through serialization roundtrip', () => {
      todoList.add('Task 1', 'high', '2026-03-30');
      todoList.add('Task 2', 'medium');
      todoList.add('Task 3', 'low');
      todoList.complete(1);
      todoList.remove(2);

      const json = todoList.toJSON();
      const restored = TodoList.fromJSON(json);

      const origStats = todoList.stats();
      const restoredStats = restored.stats();
      expect(restoredStats).toEqual(origStats);
    });
  });
});
