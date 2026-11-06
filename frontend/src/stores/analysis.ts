import { defineStore } from 'pinia';

/**
 * 分析工作台共享状态：Sidebar（数据源 + 任务列表）和 AnalysisView（报告详情）
 * 两个组件共用，所以状态必须放 store 而不是组件里。
 */
export interface DataSource { id: string; name: string; rowCount: number; owner?: string }

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    /** 分析对象来源：dataset = 上传的阅读数据（dataAnalysis）；novel = 知识库小说（novelAnalysis） */
    sourceTab: 'dataset' as 'dataset' | 'novel',
    sources: [] as DataSource[],
    /** 选中的数据源 name（发起新任务用） */
    selectedSource: '',
    /** 选中的小说 title（novelAnalysis 的分析对象） */
    selectedNovel: '',
    /** 小说分析显式关联的阅读数据集（'' = 自动匹配，匹配不到就纯文本分析） */
    novelDataset: '',
    importOpen: false,
  }),
  actions: {
    async loadSources() {
      try {
        const res = await fetch('/api/tasks/datasources');
        if (res.ok) {
          this.sources = await res.json();
          if (!this.sources.find((d) => d.name === this.selectedSource)) {
            this.selectedSource = this.sources[0]?.name ?? '';
          }
        }
      } catch { /* 后端不可达时列表为空 */ }
    },
    async removeDataset(id: string) {
      if (!window.confirm('确定删除该数据集？相关报告不受影响。')) return;
      await fetch(`/api/datasets/${id}`, { method: 'DELETE' });
      await this.loadSources();
    },
    /** 公开/私有切换：公开后其他管理员可见（游客暂不开放分析） */
    async toggleOwner(d: DataSource) {
      await fetch(`/api/datasets/${d.id}/owner`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: d.owner === 'public' ? 'admin' : 'public' }),
      });
      await this.loadSources();
    },
  },
});
