# micros-simphony-etl

Servicio ETL calendarizado en Node.js + TypeScript para:

1. Descargar exportaciones JSON de Oracle MICROS Simphony desde SFTP.
2. Parsear ventas (`CHDR`, `CDTL`, `MID`) y persistirlas en SQL Server.
3. Sincronizar ventas pendientes a SAP Business One Service Layer.

## Estructura

```text
src/
  app.ts
  config/
    env.ts
  jobs/
    nightlySyncJob.ts
  services/
    db/sqlServerClient.ts
    micros/microsParser.ts
    sap/sapServiceLayerClient.ts
    sftp/sftpClient.ts
  types/
    micros.ts
```

## Ejecución

```bash
npm install
cp .env.example .env
npm run lint
npm run test
npm run build
npm run dev
npm run manual-sync
npm run manual-full-sync
```

`npm run dev` inicia el scheduler (cron) para procesar facturas pendientes hacia SAP.
`npm run manual-sync` ejecuta una corrida única solo para procesar facturas pendientes hacia SAP.
`npm run manual-full-sync` ejecuta una corrida completa: SFTP + parseo + SQL + SAP.

Para ver logs de inserciones en SQL Server (`tFacturaSemanal` y `tFacturaDetalleSemanal`), define `ETL_DEBUG_SQL=true` en `.env`.
Para ver logs de solicitudes/respuestas hacia SAP (sin exponer password/cookies), define `ETL_DEBUG_SAP=true` en `.env`.

## Cron

Por defecto corre todos los días a las 23:00 (`0 23 * * *`) y zona `America/Mexico_City`.
Se puede ajustar con `CRON_EXPRESSION` y `CRON_TIMEZONE`.
