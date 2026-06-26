-- ============================================================
-- Factory Floor Production Tracking Tables
-- Run on: TFM SQL Server (10.60.20.20,8080) — CustomData database
-- Run once in SSMS before enabling ENABLE_FACTORY_WRITES=true
-- ============================================================

USE CustomData
GO

-- ── factory_production_sessions ──────────────────────────────────────────────
-- One row per (date × line × shift × order line).
-- Links to WP_WHOI on CSGWebPortal via whoi_id (the WP_WHOI primary key).
-- target_qty can be less than the full order qty (partial/split assignments).
-- produced_qty is incremented by factory_production_logs entries.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'factory_production_sessions'
)
BEGIN
  CREATE TABLE factory_production_sessions (
    id              INT IDENTITY(1,1)   NOT NULL PRIMARY KEY,
    session_date    DATE                NOT NULL,
    line_number     TINYINT             NOT NULL,  -- 1 or 2
    shift_number    TINYINT             NOT NULL,  -- 1 or 2
    whoi_id         INT                 NOT NULL,  -- WP_WHOI.WHOI_ID (unique line item key)
    whod_id         INT                 NOT NULL,  -- WP_WHOD.WHOD_ID (order header)
    order_number    NVARCHAR(50)        NOT NULL,
    sku             NVARCHAR(50)        NOT NULL,
    product_name    NVARCHAR(200)       NOT NULL,
    target_qty      INT                 NOT NULL,
    produced_qty    INT                 NOT NULL CONSTRAINT DF_fps_produced DEFAULT 0,
    status          NVARCHAR(20)        NOT NULL CONSTRAINT DF_fps_status   DEFAULT 'pending',
    created_at      DATETIME2           NOT NULL CONSTRAINT DF_fps_created  DEFAULT GETDATE(),
    updated_at      DATETIME2           NOT NULL CONSTRAINT DF_fps_updated  DEFAULT GETDATE(),
    CONSTRAINT UQ_factory_session UNIQUE (session_date, line_number, shift_number, whoi_id),
    CONSTRAINT CK_fps_line   CHECK (line_number  IN (1, 2)),
    CONSTRAINT CK_fps_shift  CHECK (shift_number IN (1, 2)),
    CONSTRAINT CK_fps_status CHECK (status IN ('pending', 'active', 'complete')),
    CONSTRAINT CK_fps_qty    CHECK (target_qty > 0 AND produced_qty >= 0)
  )
  PRINT 'Created factory_production_sessions'
END
ELSE
  PRINT 'factory_production_sessions already exists — skipped'
GO

-- ── factory_production_logs ──────────────────────────────────────────────────
-- Immutable audit log of every production entry made by floor workers.
-- qty_added is always positive (no corrections in this table — corrections
-- should be handled by a supervisor via a future adjustment session if needed).

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'factory_production_logs'
)
BEGIN
  CREATE TABLE factory_production_logs (
    id            INT IDENTITY(1,1)   NOT NULL PRIMARY KEY,
    session_id    INT                 NOT NULL,
    qty_added     INT                 NOT NULL,
    operator_name NVARCHAR(100)       NULL,
    note          NVARCHAR(500)       NULL,
    recorded_at   DATETIME2           NOT NULL CONSTRAINT DF_fpl_recorded DEFAULT GETDATE(),
    CONSTRAINT FK_factory_log_session
      FOREIGN KEY (session_id) REFERENCES factory_production_sessions(id),
    CONSTRAINT CK_fpl_qty CHECK (qty_added > 0)
  )
  PRINT 'Created factory_production_logs'
END
ELSE
  PRINT 'factory_production_logs already exists — skipped'
GO

-- ── Indexes ──────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_fps_date')
  CREATE INDEX IX_fps_date ON factory_production_sessions(session_date)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_fps_whoi')
  CREATE INDEX IX_fps_whoi ON factory_production_sessions(whoi_id)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_fpl_session')
  CREATE INDEX IX_fpl_session ON factory_production_logs(session_id)
GO

PRINT 'Migration complete.'
GO
