# micros-simphony-etl

Servicio ETL calendarizado en Node.js + TypeScript para:

1. Descargar exportaciones JSON de Oracle MICROS Simphony desde SFTP.
2. Parsear ventas (`CHDR`, `CDTL`, `MID`) y persistirlas en SQL Server.
3. Sincronizar ventas pendientes a SAP Business One Service Layer.
4. Descargar archivos de pedidos desde SFTP (`PEDIDOS`), enviarlos a la API POS y moverlos a `PEDIDOS/OK` cuando la API confirme exito por archivo.
5. Descargar archivos de consumos de inventario desde SFTP (`CONSUMOS`), crear Salidas de Inventario en SAP (`InventoryGenExits`) y mover a `CONSUMOS/OK` solo cuando SAP confirme el documento.

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
npm run manual-consumos-sync
npm run manual-full-sync
```

`npm run dev` inicia el scheduler (cron) para procesar facturas pendientes hacia SAP.
`npm run manual-sync` ejecuta una corrida única solo para descargar, parsear e insertar archivos MICROS.
`npm run manual-sap-sync` ejecuta una corrida única solo para procesar facturas pendientes hacia SAP.
`npm run manual-pedidos-sync` ejecuta una corrida unica de pedidos: descarga desde SFTP, envio por formulario a la API y movimiento a `PEDIDOS/OK` para archivos exitosos.
`npm run manual-consumos-sync` ejecuta una corrida unica de consumos: descarga desde `CONSUMOS`, parseo de `INVID/INV`, envio de Salida de Inventario a SAP y movimiento a `CONSUMOS/OK` solo para archivos exitosos.
`npm run manual-full-sync` ejecuta una corrida completa: SFTP + parseo + SQL + SAP.

## Operacion

Antes de desplegar, aplica las migraciones de `data/db/migrations` en orden. La migracion `003_add_delivery_control_and_scheduling.sql` agrega las tablas de control para entregas, alertas y agendas futuras.

Solo una ejecucion del middleware puede estar activa a la vez. Se usa un advisory lock de PostgreSQL para evitar que el cron y las ejecuciones manuales procesen los mismos archivos o documentos simultaneamente.

Las ventas MICROS solo se insertan y sincronizan cuando su tienda tiene `tTienda.EnableUploadingDocuments = 1`.

Las agendas se configuran en `ops.job_schedule`. El proceso recarga las agendas habilitadas cada minuto, por lo que los cambios de expresion cron, zona horaria o estado no requieren reinicio. Si no hay agendas habilitadas, se mantiene el cron definido por `CRON_EXPRESSION` y `CRON_TIMEZONE` para SAP y PEDIDOS.

Las entregas SAP y PEDIDOS se registran de forma durable. Los errores transitorios se reintentan hasta tres veces; los SKU sin mapeo y las respuestas `Validation error` de PEDIDOS generan una alerta para intervencion manual.

Las entregas de CONSUMOS tambien son durables e idempotentes por archivo/payload; se mapea `Store Number` (INVID) a `tTienda.StoreNumberSimphony` para resolver `whsCode` y `costingCode`, y `Usage Quantity` se envia en valor absoluto.

Para ver logs de inserciones en SQL Server (`tFacturaSemanal` y `tFacturaDetalleSemanal`), define `ETL_DEBUG_SQL=true` en `.env`.
Para ver logs de solicitudes/respuestas hacia SAP (sin exponer password/cookies), define `ETL_DEBUG_SAP=true` en `.env`.
Para ver logs de solicitudes/respuestas de la API de pedidos, define `ETL_DEBUG_PEDIDOS_API=true` en `.env`.
Si SAP tiene un UDF para idempotencia, define `SAP_EXTERNAL_ID_FIELD` con el nombre exacto del campo, por ejemplo `U_MICROS_ExternalId`. Si no existe ese UDF, el middleware omite ese atributo en el payload y no hace lookup previo por external id en SAP.

## Cron

Por defecto corre todos los días a las 23:00 (`0 23 * * *`) y zona `America/Mexico_City`.
Se puede ajustar con `CRON_EXPRESSION` y `CRON_TIMEZONE`.
El cron ejecuta los jobs habilitados en `ops.job_schedule` segun su expresion y zona horaria; entre ellos SAP, PEDIDOS y CONSUMOS.
