<template>
  <div class="support-page">
    <section class="support-hero">
      <p class="section-label">遇到问题 · 随时联系</p>
      <h1 class="support-title">客服与反馈</h1>
      <p class="support-desc">使用中有任何疑问、建议或需要人工协助，都可以通过以下方式联系我们。</p>
    </section>

    <el-row :gutter="16" class="support-cards">
      <el-col :xs="24" :sm="8">
        <el-card shadow="never" class="support-card">
          <div class="support-card-body">
            <div class="support-icon"><el-icon><ChatDotRound /></el-icon></div>
            <h3>微信客服</h3>
            <p class="support-tip">扫码添加客服微信，人工协助</p>
            <div class="qr-wrap">
              <img class="qr-img" src="/img/wechat-kefu.png" alt="微信客服二维码" />
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="8">
        <el-card shadow="never" class="support-card">
          <div class="support-card-body">
            <div class="support-icon"><el-icon><ChatLineRound /></el-icon></div>
            <h3>QQ 客服</h3>
            <p class="support-tip">添加 QQ 好友，备注问题类型</p>
            <div class="qq-number mono">4690734</div>
            <el-button type="primary" plain @click="copyQQ">复制 QQ 号</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :sm="8">
        <el-card shadow="never" class="support-card">
          <div class="support-card-body">
            <div class="support-icon"><el-icon><EditPen /></el-icon></div>
            <h3>建议与反馈</h3>
            <p class="support-tip">提交产品建议或问题反馈，我们会认真阅读每一条</p>
            <el-link
              type="primary"
              :href="FEEDBACK_URL"
              target="_blank"
              :underline="false"
              class="feedback-link"
            >
              填写反馈表单
              <el-icon class="el-icon--right"><TopRight /></el-icon>
            </el-link>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { ChatDotRound, ChatLineRound, EditPen, TopRight } from '@element-plus/icons-vue'

const FEEDBACK_URL = 'https://rcnhcfc58y3x.feishu.cn/share/base/form/shrcn9waNH8Jjmqe4JDvwu9DGql'
const QQ_NUMBER = '4690734'

async function copyQQ() {
  try {
    await navigator.clipboard.writeText(QQ_NUMBER)
    ElMessage.success('QQ 号已复制')
  } catch {
    ElMessage.error('复制失败，请手动记录')
  }
}
</script>

<style scoped>
.support-page {
  padding: 0 16px;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  box-sizing: border-box;
}

.support-hero {
  position: relative;
  padding: 56px 0 32px;
  margin-bottom: 8px;
}

.support-hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 78% 22%, var(--blue-glow), transparent 42%);
  pointer-events: none;
}

.support-hero > * {
  position: relative;
}

.section-label {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  color: var(--accent);
  text-transform: uppercase;
}

.support-title {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  margin: 12px 0 0 0;
}

.support-desc {
  margin: 14px 0 0 0;
  max-width: 560px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-muted);
}

.support-cards {
  margin-bottom: 24px;
}

.support-card {
  height: 100%;
  margin-bottom: 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  transition: border-color 0.25s ease, background-color 0.25s ease, transform 0.25s ease;
}

.support-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
  transform: translateY(-2px);
}

.support-card :deep(.el-card__body) {
  padding: 0;
}

.support-card-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 28px 22px 24px;
}

.support-icon {
  font-size: 28px;
  color: var(--text-secondary);
  margin-bottom: 14px;
}

.support-card h3 {
  margin: 0 0 8px 0;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}

.support-tip {
  margin: 0 0 18px 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.qr-wrap {
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: #fff;
}

.qr-img {
  display: block;
  width: 168px;
  height: 168px;
  object-fit: contain;
}

.qq-number {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 18px;
}

.feedback-link {
  font-size: 14px;
}

@media (max-width: 768px) {
  .support-page {
    padding: 0 12px;
  }

  .support-hero {
    padding: 36px 0 24px;
  }

  .support-title {
    font-size: 28px;
  }

  .support-card {
    margin-bottom: 12px;
  }
}
</style>
