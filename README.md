# micros-simphony-etl

Servicio ETL calendarizado en Node.js + TypeScript para:

1. Descargar exportaciones JSON de Oracle MICROS Simphony desde SFTP.
2. Parsear ventas (`CHDR`, `CDTL`, `MID`) y persistirlas en SQL Server.
3. Sincronizar ventas pendientes a SAP Business One Service Layer.
4. Descargar archivos de pedidos desde SFTP (`PEDIDOS`), enviarlos a la API POS y moverlos a `PEDIDOS/OK` cuando la API confirme exito por archivo.

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
npm run manual-sap-sync
npm run manual-pedidos-sync
npm run manual-full-sync
```

`npm run dev` inicia el scheduler (cron) para procesar facturas pendientes hacia SAP.
`npm run manual-sync` ejecuta una corrida única solo para descargar, parsear e insertar archivos MICROS.
`npm run manual-sap-sync` ejecuta una corrida única solo para procesar facturas pendientes hacia SAP.
`npm run manual-pedidos-sync` ejecuta una corrida unica de pedidos: descarga desde SFTP, envio por formulario a la API y movimiento a `PEDIDOS/OK` para archivos exitosos.
`npm run manual-full-sync` ejecuta una corrida completa: SFTP + parseo + SQL + SAP.

Para ver logs de inserciones en SQL Server (`tFacturaSemanal` y `tFacturaDetalleSemanal`), define `ETL_DEBUG_SQL=true` en `.env`.
Para ver logs de solicitudes/respuestas hacia SAP (sin exponer password/cookies), define `ETL_DEBUG_SAP=true` en `.env`.
Para ver logs de solicitudes/respuestas de la API de pedidos, define `ETL_DEBUG_PEDIDOS_API=true` en `.env`.

## Cron

Por defecto corre todos los días a las 23:00 (`0 23 * * *`) y zona `America/Mexico_City`.
Se puede ajustar con `CRON_EXPRESSION` y `CRON_TIMEZONE`.
El cron ejecuta primero la sincronizacion de SAP y luego el flujo de PEDIDOS.
