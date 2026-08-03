export class TelegramNotifier {
  constructor({ botToken, chatId, fetchImpl = globalThis.fetch, logger }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.botToken && this.chatId);
  }

  async notifyFailure({ job, post, account, error, terminal, nextRunAt = null }) {
    if (!this.enabled) return;

    const lines = [
      '🚨 Threads 공식 API 워커 오류',
      `계정: ${account?.accountName || account?.id || '알 수 없음'}`,
      `작업: ${job.type} #${job.id}`,
      `게시물: #${post?.id || job.postId || '없음'}`,
      `상태: ${terminal ? '최종 실패' : '재시도 예정'}`,
      `오류: ${error.code ? `[${error.code}] ` : ''}${error.message || String(error)}`,
    ];
    if (error?.details?.knownExternalId) {
      lines.push(`확인된 외부 ID: ${error.details.knownExternalId}`);
    }
    if (error?.details?.containerId) {
      lines.push(`컨테이너 ID: ${error.details.containerId}`);
    }
    if (nextRunAt) lines.push(`다음 시도: ${nextRunAt.toISOString()}`);

    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: lines.join('\n').slice(0, 4000),
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
    } catch (notifyError) {
      this.logger?.error('telegram_notification_failed', notifyError, { jobId: job.id });
    }
  }
}
