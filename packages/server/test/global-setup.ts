import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('pgUrl', pg.getConnectionUri());
  return async () => {
    await pg.stop();
  };
}
