import { PodError, SAFE_ERROR_MESSAGES } from '@shared/errors';
import type {
  CalendarArtworkCompositor,
  CalendarCompositionInput,
  CalendarCompositionReport,
} from '@shared/services';

export class UnavailableCalendarCompositor implements CalendarArtworkCompositor {
  async process(_input: CalendarCompositionInput): Promise<CalendarCompositionReport> {
    throw new PodError(
      'CALENDAR_COMPOSITING_FAILED',
      SAFE_ERROR_MESSAGES.CALENDAR_COMPOSITING_FAILED
    );
  }

  dispose(): void {
    // no-op
  }
}

export function createUnavailableCompositor(): CalendarArtworkCompositor & { dispose?(): void } {
  return new UnavailableCalendarCompositor();
}
