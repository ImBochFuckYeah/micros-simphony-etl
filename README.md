# micros-simphony-etl

Servicio ETL calendarizado en Node.js + TypeScript para:

1. Descargar exportaciones JSON de Oracle MICROS Simphony desde SFTP.
2. Parsear ventas (`CHDR`, `CDTL`, `MID`) y persistirlas en PostgreSQL.
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
    db/postgresClient.ts
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
npm run manual-pedidos-download
npm run manual-pedidos-upload
npm run manual-consumos-sync
npm run manual-consumos-download
npm run manual-consumos-upload
npm run manual-entradas-sync
npm run manual-entradas-download
npm run manual-entradas-upload
npm run manual-full-sync
```

`npm run dev` inicia el scheduler (cron) para procesar facturas pendientes hacia SAP.
`npm run manual-sync` ejecuta una corrida única solo para descargar, parsear e insertar archivos MICROS.
`npm run manual-sap-sync` ejecuta una corrida única solo para procesar facturas pendientes hacia SAP.
`npm run manual-pedidos-sync` ejecuta una corrida unica de pedidos: descarga desde SFTP, envio por formulario a la API y movimiento a `PEDIDOS/OK` cuando el archivo se procesa correctamente.
`npm run manual-pedidos-download` descarga todos los archivos pendientes de `PEDIDOS` desde SFTP para procesarlos despues (sin filtros de fecha).
`npm run manual-pedidos-upload` procesa localmente los archivos descargados de `PEDIDOS`, los envia a la API y mueve a `PEDIDOS/OK` cuando se procesan correctamente.
`npm run manual-consumos-sync` ejecuta una corrida unica de consumos: descarga desde `CONSUMOS`, parseo de `INVID/INV`, envio de Salida de Inventario a SAP y movimiento a `CONSUMOS/OK` solo para archivos exitosos.
`npm run manual-consumos-download` descarga archivos de `CONSUMOS` desde SFTP para operarlos despues en SAP.
`npm run manual-consumos-upload` opera en SAP los archivos descargados localmente de `CONSUMOS` y mueve a `CONSUMOS/OK` los exitosos.
`npm run manual-entradas-sync` ejecuta una corrida unica de entradas: descarga desde `ENTRADAS`, parseo y envio de Entrada de Inventario a SAP.
`npm run manual-entradas-download` descarga archivos de `ENTRADAS` desde SFTP para operarlos despues en SAP.
`npm run manual-entradas-upload` opera en SAP los archivos descargados localmente de `ENTRADAS`.
`npm run manual-full-sync` ejecuta una corrida completa: SFTP + parseo + PostgreSQL y, opcionalmente, SAP (sin incluir PEDIDOS).

Cuando un flujo con rango de fechas se ejecuta sin `START_DATE`/`END_DATE`, toma por defecto el dia anterior como `startDate` y `endDate`.

## Operacion

Antes de desplegar, aplica las migraciones de `data/db/migrations` en orden. La migracion `003_add_delivery_control_and_scheduling.sql` agrega las tablas de control para entregas, alertas y agendas futuras.

Las integraciones usan advisory locks de PostgreSQL para evitar ejecuciones simultaneas del mismo flujo. PEDIDOS usa un lock independiente para poder correr sin bloquear los otros jobs.

Las ventas MICROS solo se insertan y sincronizan cuando `store_number_simphony` del archivo coincide con una fila en `pos.tienda`.

Las agendas se configuran en `ops.job_schedule`. El proceso recarga las agendas habilitadas cada minuto, por lo que los cambios de expresion cron, zona horaria o estado no requieren reinicio. PEDIDOS se agenda siempre como job independiente cada 5 minutos.

Las entregas SAP y PEDIDOS se registran de forma durable. Los errores transitorios se reintentan hasta tres veces; los SKU sin mapeo y las respuestas `Validation error` de PEDIDOS generan una alerta para intervencion manual.

Las entregas de CONSUMOS tambien son durables e idempotentes por archivo/payload; se mapea `Store Number` (INVID) a `pos.tienda.store_number_simphony` para resolver `codigo_almacen_sap` y `codigo_centro_costo_sap`, y `Usage Quantity` se envia en valor absoluto.

Para ver logs de inserciones en PostgreSQL (`pos.encabezado_venta` y `pos.detalle_venta`), define `ETL_DEBUG_POSTGRES=true` en `.env`.
Para ver logs de solicitudes/respuestas hacia SAP (sin exponer password/cookies), define `ETL_DEBUG_SAP=true` en `.env`.
Para ver logs de solicitudes/respuestas de la API de pedidos, define `ETL_DEBUG_PEDIDOS_API=true` en `.env`.
Para permitir que `manual-full-sync` cargue documentos a SAP, define `FULL_SYNC_ENABLE_SAP_UPLOAD=true` (por defecto es `false`).
Si SAP tiene un UDF para idempotencia, define `SAP_EXTERNAL_ID_FIELD` con el nombre exacto del campo, por ejemplo `U_MICROS_ExternalId`. Si no existe ese UDF, el middleware omite ese atributo en el payload y no hace lookup previo por external id en SAP.

## Cron

Por defecto SAP corre todos los días a las 23:00 (`0 23 * * *`) y zona `America/Mexico_City`.
Se puede ajustar con `CRON_EXPRESSION` y `CRON_TIMEZONE`.
PEDIDOS tiene un job independiente cada 5 minutos (`*/5 * * * *`).
El cron ejecuta los jobs habilitados en `ops.job_schedule` segun su expresion y zona horaria; entre ellos SAP, PEDIDOS, CONSUMOS y ENTRADAS.
