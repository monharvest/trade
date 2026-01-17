#!/bin/bash

# Trade.mn Price Monitor - Server Management Script

case "$1" in
  start)
    echo "🚀 Starting Trade.mn Price Monitor..."
    node server.js &
    echo $! > .server.pid
    echo "✅ Server started! PID: $(cat .server.pid)"
    echo "📊 Visit http://localhost:3000"
    ;;
  
  stop)
    if [ -f .server.pid ]; then
      PID=$(cat .server.pid)
      echo "🛑 Stopping server (PID: $PID)..."
      kill $PID 2>/dev/null
      rm .server.pid
      echo "✅ Server stopped"
    else
      echo "❌ Server is not running (no PID file found)"
    fi
    ;;
  
  restart)
    $0 stop
    sleep 2
    $0 start
    ;;
  
  status)
    echo "🔍 Checking server status..."
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
      echo "✅ Server is running"
      curl -s http://localhost:3000/health | python3 -m json.tool
    else
      echo "❌ Server is not responding"
    fi
    ;;
  
  test)
    echo "🧪 Testing price check..."
    curl -s -X POST http://localhost:3000/api/check-now | python3 -m json.tool
    ;;
  
  logs)
    echo "📋 Showing last 20 log lines..."
    if [ -f nohup.out ]; then
      tail -n 20 nohup.out
    else
      echo "❌ No log file found"
    fi
    ;;
  
  *)
    echo "Trade.mn Price Monitor - Server Management"
    echo ""
    echo "Usage: $0 {start|stop|restart|status|test|logs}"
    echo ""
    echo "Commands:"
    echo "  start    - Start the monitoring server"
    echo "  stop     - Stop the monitoring server"
    echo "  restart  - Restart the monitoring server"
    echo "  status   - Check server status and configuration"
    echo "  test     - Trigger an immediate price check"
    echo "  logs     - Show recent server logs"
    echo ""
    echo "Examples:"
    echo "  $0 start      # Start server in background"
    echo "  $0 status     # Check if server is running"
    echo "  $0 test       # Test price check immediately"
    exit 1
    ;;
esac
