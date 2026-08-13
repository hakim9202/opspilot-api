export class EventDto {
  type!: string;
  severity!: string;
  title!: string;
  message!: string;
  namespace?: string;
  resource?: string;
  reason?: string;
  occurredAt!: string;
  labels?: Record<string, string>;
  metadata?: Record<string, string>;
  snapshot?: Record<string, unknown>;
}

export class BatchEventsDto {
  events!: EventDto[];
}
