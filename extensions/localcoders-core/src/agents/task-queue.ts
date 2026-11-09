import { TaskPlanItem } from './types';

export class TaskQueue {
  private tasks: Map<string, TaskPlanItem> = new Map();
  private maxConcurrency: number;

  constructor(maxConcurrency: number = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  setMaxConcurrency(limit: number) {
    this.maxConcurrency = Math.max(1, limit);
  }

  setPlan(items: TaskPlanItem[]) {
    this.tasks.clear();
    for (const item of items) {
      this.tasks.set(item.id, { ...item });
    }
  }

  getTask(id: string): TaskPlanItem | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): TaskPlanItem[] {
    return Array.from(this.tasks.values());
  }

  getReadyTasks(): TaskPlanItem[] {
    const activeCount = Array.from(this.tasks.values()).filter((t) => t.status === 'in_progress').length;
    if (activeCount >= this.maxConcurrency) {
      return [];
    }

    const availableSlots = this.maxConcurrency - activeCount;
    const ready: TaskPlanItem[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;

      // Check if all dependencies are completed
      const depsSatisfied = task.dependencies.every((depId) => {
        const depTask = this.tasks.get(depId);
        return depTask && depTask.status === 'completed';
      });

      if (depsSatisfied) {
        ready.push(task);
        if (ready.length >= availableSlots) break;
      }
    }

    return ready;
  }

  updateTaskStatus(id: string, status: TaskPlanItem['status'], output?: string) {
    const task = this.tasks.get(id);
    if (task) {
      task.status = status;
      if (status === 'in_progress' && !task.startTime) {
        task.startTime = Date.now();
      }
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        task.endTime = Date.now();
      }
      if (output !== undefined) {
        task.output = output;
      }
    }
  }

  isComplete(): boolean {
    const all = Array.from(this.tasks.values());
    if (all.length === 0) return true;
    return all.every((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled');
  }

  hasFailedTasks(): boolean {
    return Array.from(this.tasks.values()).some((t) => t.status === 'failed');
  }
}
