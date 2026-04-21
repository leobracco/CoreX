module.exports = {
  apps: [{
    name:           "corex",
    script:         "server.js",
    cwd:            "C:\\CoreX\\",
    autorestart:    true,
    max_restarts:   10,
    min_uptime:     5000,
    restart_delay:  5000,
    error_file:     "C:\\AgroParallel\\logs\\corex-error.log",
    out_file:       "C:\\AgroParallel\\logs\\corex-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs:     true,
    node_args:      "--max-old-space-size=256",
    env: {
      NODE_ENV:    "production",
      MQTT_BROKER: "mqtt://127.0.0.1:1883",
    },
  }],
};
