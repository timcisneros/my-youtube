declare module 'express-session' {
  interface SessionData {
    userId: string;
  }
}

declare global {
  namespace Express {
    interface Response {
      flushShell(opts?: Record<string, unknown>): Promise<void>;
      streamContent(template: string, data?: Record<string, unknown>): Promise<void>;
    }
  }
}

declare module 'express-serve-static-core' {
  interface Application {
    extractionRateCheck?: (ip: string, videoId?: string) => boolean;
  }
}

export {};
