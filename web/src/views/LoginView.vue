<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2>经营数据采集编排台</h2>
      <el-form @submit.prevent="doLogin">
        <el-form-item>
          <el-input v-model="username" placeholder="用户名（admin）" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="密码（admin123）" @keyup.enter="doLogin" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="doLogin">登录</el-button>
        <div v-if="error" class="err">{{ error }}</div>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const username = ref('admin');
const password = ref('admin123');
const loading = ref(false);
const error = ref('');
const router = useRouter();

async function doLogin() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.post('/auth/login', { username: username.value, password: password.value });
    localStorage.setItem('ops_token', r.data.token);
    router.push('/');
  } catch (e: any) {
    error.value = e?.response?.data?.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap { height: 100vh; display: flex; align-items: center; justify-content: center; background: #f0f2f5; }
.login-card { width: 360px; }
.err { color: #f56c6c; margin-top: 10px; }
</style>
