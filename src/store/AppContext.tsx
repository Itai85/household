import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { Service, Bill, Document } from '../types';
import { calcBillAvgMonthly, today } from '../types';
import * as storage from '../platform/storage';

interface AppState {
  services: Service[];
  loading: boolean;
  reload: () => Promise<void>;
  // Service CRUD
  saveService: (s: Service) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
  // Bill CRUD
  getBills: (serviceId: string) => Promise<Bill[]>;
  saveBill: (b: Bill) => Promise<void>;
  deleteBill: (id: string) => Promise<void>;
  // Document CRUD
  getDocs: (serviceId: string) => Promise<Document[]>;
  getDoc: (id: string) => Promise<Document | undefined>;
  saveDoc: (d: Document) => Promise<void>;
  deleteDoc: (id: string) => Promise<void>;
  // File storage
  saveFile: (id: string, bytes: ArrayBuffer, mimeType: string, fileName: string) => Promise<void>;
  loadFile: (id: string) => Promise<{ bytes: ArrayBuffer; mimeType: string; fileName: string } | undefined>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const all = await storage.getAllServices();

    // Auto-compute bill averages for services that don't have them yet
    for (const svc of all) {
      if (svc.billAvgMonthlyCents === undefined) {
        const bills = await storage.getBillsForService(svc.id);
        if (bills.length > 0) {
          const avg = calcBillAvgMonthly(bills);
          svc.billAvgMonthlyCents = avg;
          svc.billCount = bills.length;
          svc.updatedAt = today();
          await storage.saveService(svc);
        }
      }
    }

    setServices(all.sort((a, b) => a.nickname.localeCompare(b.nickname)));
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const saveService = useCallback(async (s: Service) => {
    await storage.saveService(s);
    await reload();
  }, [reload]);

  const deleteService = useCallback(async (id: string) => {
    await storage.deleteService(id);
    await reload();
  }, [reload]);

  /** After saving/deleting a bill, recalculate the service's average monthly cost */
  const refreshBillAvg = useCallback(async (serviceId: string) => {
    const bills = await storage.getBillsForService(serviceId);
    const avg = calcBillAvgMonthly(bills);
    const svc = (await storage.getAllServices()).find(s => s.id === serviceId);
    if (svc && (svc.billAvgMonthlyCents !== avg || svc.billCount !== bills.length)) {
      await storage.saveService({ ...svc, billAvgMonthlyCents: avg, billCount: bills.length, updatedAt: today() });
      await reload();
    }
  }, [reload]);

  const saveBillAndRefresh = useCallback(async (b: Bill) => {
    await storage.saveBill(b);
    await refreshBillAvg(b.serviceId);
  }, [refreshBillAvg]);

  const deleteBillAndRefresh = useCallback(async (id: string) => {
    // Find the serviceId before deleting — scan all services
    const allSvcs = await storage.getAllServices();
    let affectedServiceId = '';
    for (const svc of allSvcs) {
      const bills = await storage.getBillsForService(svc.id);
      if (bills.some(b => b.id === id)) {
        affectedServiceId = svc.id;
        break;
      }
    }
    await storage.deleteBill(id);
    if (affectedServiceId) await refreshBillAvg(affectedServiceId);
  }, [refreshBillAvg]);

  const value: AppState = {
    services, loading, reload, saveService, deleteService,
    getBills: storage.getBillsForService,
    saveBill: saveBillAndRefresh,
    deleteBill: deleteBillAndRefresh,
    getDocs: storage.getDocsForService,
    getDoc: storage.getDocument,
    saveDoc: storage.saveDocument,
    deleteDoc: storage.deleteDocument,
    saveFile: storage.saveFile,
    loadFile: storage.loadFile,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
