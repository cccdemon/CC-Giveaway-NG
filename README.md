# CC-Giveaway NG

Neubau der Giveaway-Plattform. Das Design steht in [NEW_DESIGN.md](NEW_DESIGN.md).

## Entwickeln

1. Node 24 und Docker installieren.
2. `npm ci` ausführen.
3. `docker compose -f docker-compose.dev.yml up -d` startet PostgreSQL und Redis.
4. `.env.example` nach `.env` kopieren.
5. `npm test` startet alle Tests. Die Tests starten eigene Container.
