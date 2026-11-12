/**
 * Loading Animation Manager
 *
 * Manages loading state and animation for session view components.
 * Provides a centralized way to start/stop loading animations with
 * consistent visual feedback.
 */

// Braille spinner glyphs, shown by index.
const LOADING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Manages loading state and animation for session views
 */
export class LoadingAnimationManager {
  private loading = false;
  private loadingFrame = 0;
  private loadingInterval: number | null = null;

  /**
   * Check if currently in loading state
   */
  isLoading(): boolean {
    return this.loading;
  }

  /**
   * Start loading animation with callback for updates
   */
  startLoading(onUpdate?: () => void): void {
    this.loading = true;
    this.loadingFrame = 0;
    // 2026-11-10: the frame wrapped at 4 of 10 glyphs, so frames 4-9 never showed.
    this.loadingInterval = window.setInterval(() => {
      this.loadingFrame = (this.loadingFrame + 1) % LOADING_FRAMES.length;
      if (onUpdate) {
        onUpdate();
      }
    }, 200) as unknown as number; // Update every 200ms for smooth animation
  }

  /**
   * Stop loading animation
   */
  stopLoading(): void {
    this.loading = false;
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
  }

  /**
   * Get current loading animation text frame
   */
  getLoadingText(): string {
    return LOADING_FRAMES[this.loadingFrame % LOADING_FRAMES.length];
  }

  /**
   * Clean up any active intervals
   */
  cleanup(): void {
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
  }
}
