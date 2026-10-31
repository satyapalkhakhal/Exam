// pg is installed (via @prisma/adapter-pg) but @types/pg is not a dependency of
// this package; the migration integration test only needs this much of it.
declare module 'pg' {
  export interface QueryResult {
    rows: any[];
  }
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    end(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<QueryResult>;
  }
  const pg: { Client: typeof Client };
  export default pg;
}
