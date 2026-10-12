import { Injectable } from '@nestjs/common'
import { Subject, type Observable } from 'rxjs'

export type EventChannel = 'run' | 'models' | 'orchestrator' | 'jobs' | 'system' | 'project'

export interface AppEvent {
  channel: EventChannel
  type: string
  /** Execution id, model name, project id … depending on the channel. */
  subject?: string
  data: Record<string, unknown>
  ts: string
}

/** In-process pub/sub; streamed to the desktop shell and the web UI via Server-Sent Events. */
@Injectable()
export class EventBusService {
  private readonly subject = new Subject<AppEvent>()

  publish(channel: EventChannel, type: string, data: Record<string, unknown> = {}, subject?: string) {
    this.subject.next({ channel, type, subject, data, ts: new Date().toISOString() })
  }

  stream(): Observable<AppEvent> {
    return this.subject.asObservable()
  }
}
