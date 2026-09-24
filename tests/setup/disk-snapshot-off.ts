// 单测隔离：关闭 webhook 的磁盘快照（避免读到真实 ~/.aceharness/runs 破坏测试确定性）
process.env.ACE_WEBHOOK_DISK_SNAPSHOT = '0';
