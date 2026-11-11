// Minimal typing for the raw `pg` client used by drivesMigration.int.test.ts
// (the API itself reaches pg only through @prisma/adapter-pg, so @types/pg is
// not a dependency). Same approach as ioredis-mock.d.ts.
declare module 'pg' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = Record<string, any>;
  class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
    end(): Promise<void>;
  }
  const pg: { Client: typeof Client };
  export default pg;
  export { Client };
}
