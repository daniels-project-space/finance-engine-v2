#!/bin/bash
# Fable ideation via owner-authenticated Claude Code CLI (Max plan, personal use).
exec 9>/tmp/fev2-ideate.lock
flock -n 9 || exit 0
source /root/.fev2-env
cd /home/ubuntu/finance-engine-v2
echo "=== $(date -u +%FT%TZ) ideate ===" >> /tmp/ideate.log
npx tsx scripts/ideate-cli.ts 6 >> /tmp/ideate.log 2>&1
