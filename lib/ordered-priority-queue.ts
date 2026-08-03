interface OrderedPriorityItem {
  priority: number;
  order: number;
}

/**
 * Insert into an already ordered array without sorting the whole wait queue.
 * Lower priority numbers run first; order preserves FIFO within a priority.
 */
function insertPriorityItem<T extends OrderedPriorityItem>(queue: T[], item: T) {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = queue[middle];
    if (current.priority > item.priority
      || (current.priority === item.priority && current.order > item.order)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  queue.splice(low, 0, item);
}

export { insertPriorityItem };
export type { OrderedPriorityItem };
