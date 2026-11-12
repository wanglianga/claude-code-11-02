<template>
  <router-view v-if="isLogin" />
  <el-container v-else class="layout">
    <el-aside width="220px">
      <div class="logo">采集编排台</div>
      <el-menu :default-active="$route.path" router background-color="#1f2d3d" text-color="#bfcbd9" active-text-color="#ffd04b">
        <el-menu-item index="/">今日采集看板</el-menu-item>
        <el-menu-item index="/tasks">任务中心</el-menu-item>
        <el-menu-item index="/interventions">人工接管</el-menu-item>
        <el-menu-item index="/daily">门店日视图</el-menu-item>
        <el-menu-item index="/issues">映射异常</el-menu-item>
        <el-menu-item index="/upload">人工补传</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="title">连锁餐饮 · 经营数据采集编排台</span>
        <el-button size="small" @click="logout">退出登录</el-button>
      </el-header>
      <el-main><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
const route = useRoute();
const router = useRouter();
const isLogin = computed(() => route.path === '/login');
function logout() {
  localStorage.removeItem('ops_token');
  router.push('/login');
}
</script>

<style>
body { margin: 0; font-family: 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.layout { height: 100vh; }
.el-aside { background: #1f2d3d; }
.logo { color: #fff; font-weight: 700; padding: 18px 20px; font-size: 17px; }
.el-menu { border-right: none; }
.header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e4e7ed; }
.header .title { font-weight: 600; color: #303133; }
</style>
