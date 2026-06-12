#!/bin/bash
source /root/.fev2-env
cd /home/ubuntu/finance-engine-v2
for i in $(seq 1 16); do
  echo "=== GRIND CYCLE $i/8 $(date -u +%H:%M) ===" >> /tmp/grind.log
  npx tsx scripts/cycle-local.ts 2 >> /tmp/grind.log 2>&1
done
echo "=== GRIND COMPLETE $(date -u +%H:%M) ===" >> /tmp/grind.log
