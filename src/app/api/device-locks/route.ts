import { NextRequest, NextResponse } from 'next/server';
import { listLockedDevices, getDeviceLockStatus, cleanupStaleLocks } from '@/lib/workflow/device-lock';

/**
 * GET /api/device-locks
 * 查询所有设备锁状态，或查询单个设备锁状态（?deviceId=xxx）
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const deviceId = searchParams.get('deviceId');

    // 先清理过期锁
    const cleaned = cleanupStaleLocks();

    if (deviceId) {
      // 查询单个设备
      const lockInfo = getDeviceLockStatus(deviceId);
      return NextResponse.json({
        success: true,
        deviceId,
        locked: Boolean(lockInfo),
        lockInfo,
        cleanedStaleLocks: cleaned,
      });
    }

    // 查询所有锁
    const locks = listLockedDevices();
    return NextResponse.json({
      success: true,
      lockedDevices: locks,
      count: locks.length,
      cleanedStaleLocks: cleaned,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
