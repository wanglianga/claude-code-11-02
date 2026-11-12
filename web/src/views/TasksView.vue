<template>
  <div>
    <div class="toolbar">
      <el-date-picker v-model="filters.date" type="date" value-format="YYYY-MM-DD" clearable placeholder="日期" @change="load" />
      <el-select v-model="filters.status" placeholder="状态" clearable style="width: 140px" @change="load">
        <el-option v-for="(v, k) in STATUS_META" :key="k" :label="v.label" :value="k" />
      </el-select>
      <el-select v-model="filters.storeId" placeholder="门店" clearable style="width: 150px" @change="load">
        <el-option v-for="s in meta.stores" :key="s.id" :label="`${s.code} ${s.name}`" :value="s.id" />
      </el-select>
      <el-select v-model="filters.platformId" placeholder="平台" clearable style="width: 150px" @change="load">
        <el-option v-for="p in meta.platforms" :key="p.id" :label="`${p.code} ${p.name}`" :value="p.id" />
      </el-select>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-table :data="tasks" border size="small" v-loading="loading">
      <el-table-column prop="biz_date" label="营业日" width="110" />
      <el-table-column label="门店" width="150">
        <template #default="{ row }">{{ row.store_code }} {{ row.store_name }}</template>
      </el-table-column>
      <el-table-column prop="platform_code" label="平台" width="90" />
      <el-table-column prop="username" label="账号" width="100" />
      <el-table-column prop="source_kind" label="来源" width="130">
        <template #default="{ row }">{{ kindLabel(row.source_kind) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="STATUS_META[row.status]?.type || 'info'" size="small">{{ STATUS_META[row.status]?.label || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="run_count" label="执行次数" width="80" />
      <el-table-column prop="last_error" label="最近错误" show-overflow-tooltip />
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="$router.push(`/tasks/${row.id}`)">详情</el-button>
          <el-button size="small" link type="warning" @click="rerun(row)">重跑</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, STATUS_META } from '../api';

const meta = ref<any>({ stores: [], platforms: [] });
const tasks = ref<any[]>([]);
const loading = ref(false);
const filters = reactive<any>({ date: '', status: '', storeId: null, platformId: null });

const kindLabel = (k: string) => ({ web_export: '网页导出', download_center: '下载中心', api: '接口拉取', manual: '人工上传' }[k] || k);

async function load() {
  loading.value = true;
  try {
    const params: any = {};
    for (const k of ['date', 'status', 'storeId', 'platformId']) if (filters[k]) params[k] = filters[k];
    tasks.value = (await api.get('/tasks', { params })).data;
  } finally {
    loading.value = false;
  }
}
async function rerun(row: any) {
  await api.post(`/tasks/${row.id}/rerun`);
  ElMessage.success('已重新入队');
  setTimeout(load, 500);
}
onMounted(async () => {
  meta.value = (await api.get('/meta')).data;
  await load();
});
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; margin-bottom: 12px; }
</style>
