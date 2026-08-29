import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initAnalytics } from './analytics'
import ElementPlus from 'element-plus'
// EP 默认主题先加载，自定义暗色 token 后加载才能覆盖 --el-* 变量
import 'element-plus/dist/index.css'
import './style.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import i18n, { bootstrapLocale } from './i18n'

bootstrapLocale()

const app = createApp(App)

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app
  .use(router)
  .use(ElementPlus)
  .use(i18n)
  .mount('#app')

initAnalytics(router)
