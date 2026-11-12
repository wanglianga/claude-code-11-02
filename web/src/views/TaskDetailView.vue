<template>
  <div v-if="detail.task">
    <el-card>
      <template #header>
        <div class="head">
          <span>任务 {{ detail.task.store_code }} / {{ detail.task.platform_code }} / {{ detail.task.username }} / {{ detail.task.biz_date }}</span>
          <el-button size="small" type="warning" @click="rerun">重跑任务</el-button>
        </div>
      </template>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="状态">
          <el-tag :type="STATUS_META[detail.task.status]?.type || 'info'" size="small">{{ STATUS_META[detail.task.status]?.label || detail.task.status }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="来源">{{ detail.task.source_kind }}</el-descriptions-item>
        <el-descriptions-item label="执行次数">{{ detail.task.run_count }}</el-descriptions-item>
        <el-descriptions-item label="最近错误">{{ detail.task.last_error || '-' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="mt">
      <template #header>执行记录（每次执行独立留痕）</template>
      <el-table :data="detail.runs" size="small" border @expand-change="(row: any) => loadSteps(row.id)">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="steps" v-loading="!steps[row.id]">
              <el-timeline v-if="steps[row.id]">
                <el-timeline-item v-for="s in steps[row.id]" :key="s.id" :timestamp="s.created_at"
                  :type="s.status === 'failed' ? 'danger' : s.status === 'info' ? 'info' : 'success'">
                  <b>{{ s.name }}</b>
                  <span v-if="s.message"> — {{ s.message }}</span>
                  <div v-if="s.screenshot_path" class="shot">
                    <el-image :src="`/api/static/${s.screenshot_path}`" :preview-src-list="[`/api/static/${s.screenshot_path}`]"
                      fit="contain" style="max-width: 420px; max-height: 240px" preview-teleported />
                  </div>
                </el-timeline-item>
              </el-timeline>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="attempt_no" label="#" width="50" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="STATUS_META[row.status]?.type || 'info'" size="small">{{ STATUS_META[row.status]?.label || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="started_at" label="开始" width="180" />
        <el-table-column prop="finished_at" label="结束" width="180" />
        <el-table-column prop="error_code" label="错误码" width="160" />
        <el-table-column prop="error_message" label="错误信息" show-overflow-tooltip />
      </el-table>
    </el-card>

    <el-card class="mt">
      <template #header>采集文件（证据链）</template>
      <el-table :data="detail.files" size="small" border>
        <el-table-column prop="file_name" label="文件名" min-width="220" show-overflow-tooltip />
        <el-table-column label="哈希" width="110">
          <template #default="{ row }"><code>{{ row.sha256.slice(0, 10) }}</code></template>
        </el-table-column>
        <el-table-column prop="revision" label="修订" width="60" />
        <el-table-column prop="origin" label="来源" width="70">
          <template #default="{ row }">
            <el-tag size="small" :type="row.origin === 'manual' ? 'warning' : 'info'">{{ row.origin === 'manual' ? '人工' : '自动' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="fileStatusType(row.status)">{{ fileStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="downloaded_at" label="采集时间" width="180" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="downloadEvidence(row.id, row.file_name)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="mt" v-if="detail.interventions.length">
      <template #header>人工接管记录</template>
      <el-table :data="detail.interventions" size="small" border>
        <el-table-column prop="kind" label="类型" width="120">
          <template #default="{ row }">{{ KIND_LABELS[row.kind] || row.kind }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column prop="note" label="说明" />
        <el-table-column prop="created_at" label="时间" width="180" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, STATUS_META, KIND_LABELS, downloadEvidence } from '../api';

const route = useRoute();
const router = useRouter();
const detail = ref<any>({});
const steps = reactive<Record<string, any[]>>({});

const fileStatusLabel = (s: string) => ({ active: '有效', superseded: '已被取代', rejected: '错误文件', ignored_manual: '人工优先' }[s] || s);
const fileStatusType = (s: string) => ({ active: 'success', superseded: 'info', rejected: 'danger', ignored_manual: 'warning' }[s] || 'info');

async function load() {
  detail.value = (await api.get(`/tasks/${route.params.id}`)).data;
}
async function loadSteps(runId: string) {
  steps[runId] = (await api.get(`/runs/${runId}/steps`)).data;
}
async function rerun() {
  await api.post(`/tasks/${route.params.id}/rerun`);
  ElMessage.success('已重新入队');
  setTimeout(() => router.push('/tasks'), 600);
}
onMounted(load);
</script>

<style scoped>
.mt { margin-top: 12px; }
.head { display: flex; justify-content: space-between; align-items: center; }
.steps { padding: 8px 16px; }
.shot { margin-top: 6px; }
</style>
