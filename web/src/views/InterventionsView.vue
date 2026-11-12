<template>
  <div>
    <el-alert type="warning" :closable="false" class="mb"
      title="出现人机验证 / 短信 / 人工确认 / 登录失效时，采集流程会安全暂停。请在线下或平台后台完成处理后，点击「已处理，继续采集」。系统不会尝试绕过任何验证。" />
    <el-radio-group v-model="status" @change="load" class="mb">
      <el-radio-button value="open">待处理</el-radio-button>
      <el-radio-button value="resolved">已处理</el-radio-button>
      <el-radio-button value="cancelled">已取消</el-radio-button>
    </el-radio-group>
    <el-table :data="rows" border size="small" v-loading="loading">
      <el-table-column prop="created_at" label="时间" width="180" />
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="row.kind === 'login_expired' ? 'danger' : 'warning'" size="small">{{ KIND_LABELS[row.kind] || row.kind }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="任务" width="220">
        <template #default="{ row }">{{ row.store_code }} / {{ row.platform_code }} / {{ row.username }} / {{ row.biz_date }}</template>
      </el-table-column>
      <el-table-column prop="note" label="说明" show-overflow-tooltip />
      <el-table-column label="现场截图" width="120">
        <template #default="{ row }">
          <el-image v-if="row.screenshot_path" :src="`/api/static/${row.screenshot_path}`"
            :preview-src-list="[`/api/static/${row.screenshot_path}`]" fit="cover"
            style="width: 90px; height: 50px" preview-teleported />
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" v-if="status === 'open'">
        <template #default="{ row }">
          <el-button size="small" type="success" @click="resolve(row)">已处理，继续采集</el-button>
          <el-button size="small" type="danger" plain @click="cancel(row)">取消任务</el-button>
        </template>
      </el-table-column>
      <el-table-column prop="resolved_by" label="处理人" width="90" v-else />
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, KIND_LABELS } from '../api';

const rows = ref<any[]>([]);
const status = ref('open');
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    rows.value = (await api.get('/interventions', { params: { status: status.value } })).data;
  } finally {
    loading.value = false;
  }
}
async function resolve(row: any) {
  await ElMessageBox.confirm(
    `确认已完成「${KIND_LABELS[row.kind] || row.kind}」的人工处理？确认后系统将恢复场景并重新执行采集。`,
    '人工接管确认',
  );
  await api.post(`/interventions/${row.id}/resolve`, { note: '运营人员已人工处理' });
  ElMessage.success('已恢复并重新入队');
  setTimeout(load, 500);
}
async function cancel(row: any) {
  await ElMessageBox.confirm('取消后该任务标记为失败，可在任务中心重跑。', '取消任务');
  await api.post(`/interventions/${row.id}/cancel`);
  ElMessage.success('已取消');
  setTimeout(load, 500);
}
onMounted(load);
</script>

<style scoped>
.mb { margin-bottom: 12px; }
</style>
