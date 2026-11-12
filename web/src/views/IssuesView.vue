<template>
  <div>
    <el-radio-group v-model="status" @change="load" class="mb">
      <el-radio-button value="open">待处理</el-radio-button>
      <el-radio-button value="resolved">已处理</el-radio-button>
    </el-radio-group>
    <el-table :data="rows" border size="small" v-loading="loading">
      <el-table-column prop="created_at" label="时间" width="180" />
      <el-table-column prop="issue_type" label="类型" width="150" />
      <el-table-column label="位置" width="220">
        <template #default="{ row }">{{ row.store_code || '-' }} / {{ row.platform_code || '-' }} / {{ row.biz_date || '-' }}</template>
      </el-table-column>
      <el-table-column prop="file_name" label="文件" width="220" show-overflow-tooltip />
      <el-table-column prop="field" label="字段" width="80" />
      <el-table-column prop="message" label="说明" show-overflow-tooltip />
      <el-table-column label="操作" width="100" v-if="status === 'open'">
        <template #default="{ row }">
          <el-button size="small" type="success" plain @click="resolve(row)">标记已处理</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

const rows = ref<any[]>([]);
const status = ref('open');
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    rows.value = (await api.get('/issues', { params: { status: status.value } })).data;
  } finally {
    loading.value = false;
  }
}
async function resolve(row: any) {
  await api.post(`/issues/${row.id}/resolve`);
  ElMessage.success('已标记');
  load();
}
onMounted(load);
</script>

<style scoped>
.mb { margin-bottom: 12px; }
</style>
