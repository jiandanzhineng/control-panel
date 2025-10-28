<template>
  <div class="layout">
    <header class="topbar">
      <nav class="nav">
        <RouterLink to="/home" class="link" active-class="active">首页</RouterLink>
        <RouterLink to="/services" class="link" active-class="active">服务管理</RouterLink>
        <RouterLink to="/devices" class="link" active-class="active">设备管理</RouterLink>
        <RouterLink to="/gamelist" class="link" active-class="active">游戏列表</RouterLink>
        <RouterLink to="/games/current" class="link" active-class="active">当前游戏</RouterLink>
      </nav>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
// 使用 vue-router 的 RouterLink/RouterView，无需手动管理 hash
</script>

<style>
.layout { min-height: 100vh; display: flex; flex-direction: column; }
.topbar { border-bottom: 1px solid #e5e7eb; background: #fff; }
.nav { max-width: 960px; margin: 0 auto; padding: 12px 24px; display: flex; gap: 16px; }
.link { text-decoration: none; color: #111827; padding: 6px 10px; border-radius: 6px; }
.active { background: #e0f2fe; color: #0ea5e9; }
.content { max-width: 960px; margin: 0 auto; padding: 24px; width: 100%; }
</style>
