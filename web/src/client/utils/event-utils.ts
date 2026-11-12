/**
 * Event utility functions for consistent event handling across the application
 */

/**
 * Prevents default action and stops event propagation.
 * Use this when you need to completely consume an event, preventing both
 * default browser behavior and event bubbling.
 *
 * Common use cases:
 * - Modal dialogs (prevent backdrop clicks from closing)
 * - Drag and drop operations
 * - Custom keyboard shortcuts
 * - Nested interactive elements
 *
 * @param e The event to consume
 */
export function consumeEvent<T extends Event>(e: T): void {
  e.preventDefault();
  e.stopPropagation();
}
