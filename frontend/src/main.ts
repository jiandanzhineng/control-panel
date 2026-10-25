import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initAnalytics } from './analytics'
import { ElLoading } from 'element-plus'
// EP 默认主题先加载，自定义暗色 token 后加载才能覆盖 --el-* 变量
import 'element-plus/dist/index.css'
import './style.css'
import i18n, { bootstrapLocale } from './i18n'

bootstrapLocale()

const app = createApp(App)

app.directive('loading', ElLoading.directive)

app
  .use(router)
  .use(i18n)
  .mount('#app')

initAnalytics(router)
