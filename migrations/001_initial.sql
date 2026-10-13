CREATE TABLE cryptocurrencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0 AND id <= 9007199254740991),
    cmc_id INTEGER NOT NULL UNIQUE
        CHECK (typeof(cmc_id) = 'integer' AND cmc_id > 0 AND cmc_id <= 9007199254740991),
    symbol TEXT NOT NULL CHECK (length(trim(symbol)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    tracking_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(tracking_enabled) = 'integer' AND tracking_enabled IN (0, 1)),
    created_at TEXT NOT NULL
        CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
    updated_at TEXT NOT NULL
        CHECK (length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
    last_price_received_at TEXT
        CHECK (last_price_received_at IS NULL OR
            (length(last_price_received_at) = 24 AND
             strftime('%Y-%m-%dT%H:%M:%fZ', last_price_received_at) IS last_price_received_at))
);

CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0 AND id <= 9007199254740991),
    cryptocurrency_id INTEGER NOT NULL REFERENCES cryptocurrencies(id) ON DELETE CASCADE
        CHECK (typeof(cryptocurrency_id) = 'integer' AND cryptocurrency_id > 0),
    price REAL NOT NULL
        CHECK (typeof(price) IN ('integer', 'real') AND price >= 0 AND price <= 1.7976931348623157e308),
    received_at TEXT NOT NULL
        CHECK (length(received_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at),
    source_updated_at TEXT
        CHECK (source_updated_at IS NULL OR
            (length(source_updated_at) = 24 AND
             strftime('%Y-%m-%dT%H:%M:%fZ', source_updated_at) IS source_updated_at))
);

CREATE INDEX idx_price_history_coin_received_id
    ON price_history(cryptocurrency_id, received_at DESC, id DESC);
CREATE INDEX idx_cryptocurrencies_tracking_id
    ON cryptocurrencies(tracking_enabled, id);
