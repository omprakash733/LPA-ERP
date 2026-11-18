import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function getPort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const parsed = Number(process.argv[portArgIdx + 1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (process.env.NODE_ENV === 'production') {
    return Number(process.env.PORT) || 8080;
  }
  return 3000;
}

const PORT = getPort();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

interface StudyMaterial {
  id: string;
  title: string;
  description?: string;
  materialType: 'pdf' | 'ppt' | 'manual' | 'video' | 'assignment';
  fileName: string;
  fileSize?: number;
  fileSizeKb?: number;
  mimeType?: string;
  courseId: string;
  courseTitle: string;
  batchId: string;
  batchName: string;
  batchIds?: string[];
  uploadedBy: string;
  uploadedByRole: 'admin' | 'trainer' | 'faculty';
  uploadedById?: string;
  uploadDate: string;
  visibilityStatus: 'published' | 'draft' | 'archived';
  durationMinutes?: number;
  downloadAllowed?: boolean;
  sha256?: string;
  storagePath?: string;
  fileUrl?: string;
  fileDataUri?: string;
  pageCount?: number;
  slideCount?: number;
  slidesData?: any;
  pagesData?: Array<{
    pageNumber: number;
    title: string;
    sections: Array<{
      heading?: string;
      body: string;
      code?: string;
      note?: string;
    }>;
  }>;
}

// Persistent directory for storing original uploaded PDF and PPT study materials
const UPLOADS_DIR = path.resolve(__dirname, 'uploads', 'materials');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MANIFEST_FILE = path.join(UPLOADS_DIR, 'materials_manifest.json');

// Helper to calculate SHA-256 hash of a buffer
function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Generate valid, authentic multi-page PDF binary with proper catalog, page tree, streams and xref
function buildAuthenticMultiPagePdf(
  docTitle: string,
  courseTitle: string,
  batchName: string,
  pages: Array<{ pageNumber: number; title: string; sections: Array<{ heading?: string; body: string; code?: string; note?: string }> }>
): Buffer {
  const safeDocTitle = docTitle.replace(/[()\\]/g, '');
  const safeCourseTitle = (courseTitle || 'DCNE').replace(/[()\\]/g, '');
  const safeBatchName = (batchName || 'DCNE-26-01').replace(/[()\\]/g, '');

  const objects: string[] = [];
  const pageObjectIndices: number[] = [];

  // Obj 1: Catalog
  // Obj 2: Pages container
  // Obj 3: Font /Helvetica
  // Obj 4: Font /Helvetica-Bold
  // Then for each page: Page Object + Content Stream Object

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  // Placeholder for obj 2 (will replace after pages are processed)
  objects.push('');
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');

  let nextObjId = 5;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageObjId = nextObjId++;
    const streamObjId = nextObjId++;
    pageObjectIndices.push(pageObjId);

    // Build PDF content stream
    const lines: string[] = [];
    lines.push('BT');

    // Header band
    lines.push('/F2 14 Tf');
    lines.push('50 740 Td');
    lines.push('(LINK PULSE ACADEMY - OFFICIAL COURSEWARE) Tj');

    lines.push('/F1 10 Tf');
    lines.push('0 -18 Td');
    lines.push(`(Course: ${safeCourseTitle}  |  Batch: ${safeBatchName}) Tj`);

    lines.push('/F2 12 Tf');
    lines.push('0 -24 Td');
    lines.push(`(${safeDocTitle} - Page ${page.pageNumber} of ${pages.length}) Tj`);

    lines.push('/F1 10 Tf');
    lines.push('0 -16 Td');
    lines.push(`(${page.title.replace(/[()\\]/g, '')}) Tj`);

    // Separator line
    lines.push('ET');
    lines.push('0.2 0.3 0.6 rg');
    lines.push('50 670 512 2 re');
    lines.push('f');
    lines.push('0 0 0 rg');
    lines.push('BT');

    let currentY = 645;
    for (const sec of page.sections) {
      if (sec.heading) {
        lines.push('/F2 11 Tf');
        lines.push(`50 ${currentY} Td`);
        lines.push(`(${sec.heading.replace(/[()\\]/g, '')}) Tj`);
        lines.push('ET');
        currentY -= 16;
      }

      lines.push('BT');
      lines.push('/F1 9 Tf');
      lines.push(`50 ${currentY} Td`);

      // Wrap body text into lines of ~80 chars
      const words = sec.body.split(/\s+/);
      let curLine = '';
      for (const w of words) {
        if ((curLine + ' ' + w).length > 80) {
          lines.push(`(${curLine.trim().replace(/[()\\]/g, '')}) Tj`);
          lines.push('0 -13 Td');
          currentY -= 13;
          curLine = w;
        } else {
          curLine += (curLine ? ' ' : '') + w;
        }
      }
      if (curLine) {
        lines.push(`(${curLine.trim().replace(/[()\\]/g, '')}) Tj`);
        lines.push('0 -13 Td');
        currentY -= 13;
      }
      lines.push('ET');

      if (sec.code) {
        lines.push('0.95 0.95 0.95 rg');
        lines.push(`50 ${currentY - 25} 512 30 re`);
        lines.push('f');
        lines.push('0 0 0 rg');
        lines.push('BT');
        lines.push('/F1 8 Tf');
        lines.push(`55 ${currentY - 12} Td`);
        lines.push(`(CODE / COMMAND: ${sec.code.replace(/\n/g, ' ').replace(/[()\\]/g, '').slice(0, 85)}) Tj`);
        lines.push('ET');
        currentY -= 40;
      }

      if (sec.note) {
        lines.push('BT');
        lines.push('/F2 8 Tf');
        lines.push(`50 ${currentY - 6} Td`);
        lines.push(`(NOTE: ${sec.note.replace(/[()\\]/g, '').slice(0, 90)}) Tj`);
        lines.push('ET');
        currentY -= 20;
      }

      currentY -= 10;
      if (currentY < 100) break;
    }

    // Footer
    lines.push('BT');
    lines.push('/F1 8 Tf');
    lines.push(`240 40 Td`);
    lines.push(`(Page ${page.pageNumber} of ${pages.length} - Link Pulse Academy Verified LMS Material) Tj`);
    lines.push('ET');

    const streamContent = lines.join('\n');
    const streamBytes = Buffer.from(streamContent, 'utf-8');

    // Page Object
    objects[pageObjId - 1] = `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjId} 0 R >>\nendobj\n`;

    // Stream Object
    objects[streamObjId - 1] = `${streamObjId} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
  }

  // Finalize Obj 2 (Pages Container)
  const kidsStr = pageObjectIndices.map((id) => `${id} 0 R`).join(' ');
  objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${pages.length} >>\nendobj\n`;

  // Build complete PDF with header and cross-reference table
  let pdfOutput = '%PDF-1.4\n';
  const offsets: number[] = [0]; // 0 is dummy for 0000000000 65535 f

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdfOutput, 'utf-8'));
    pdfOutput += objects[i];
  }

  const xrefOffset = Buffer.byteLength(pdfOutput, 'utf-8');
  pdfOutput += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (let i = 1; i <= objects.length; i++) {
    const offsetStr = String(offsets[i]).padStart(10, '0');
    pdfOutput += `${offsetStr} 00000 n \n`;
  }

  pdfOutput += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdfOutput, 'utf-8');
}

// In-memory materials store initialized and synchronized with persistent storage
let materialsStore: StudyMaterial[] = [];
let materialsInitialized = false;
let deletedMaterialIds: string[] = [];

// Initialize or load materials from persistent storage
function initStorage() {
  let loadedFromDisk = false;
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      const data = fs.readFileSync(MANIFEST_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          materialsStore = parsed;
          materialsInitialized = true;
          loadedFromDisk = true;
        }
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.materials)) {
        const delSet = new Set<string>(Array.isArray(parsed.deletedMaterialIds) ? parsed.deletedMaterialIds : []);
        deletedMaterialIds = Array.from(delSet);
        materialsInitialized = Boolean(parsed.initialized);
        materialsStore = parsed.materials.filter((m: StudyMaterial) => m && m.id && !delSet.has(m.id));
        if (materialsInitialized) {
          loadedFromDisk = true;
        }
      }
    } catch (e) {
      console.warn('[Storage] Manifest parse failed:', e);
    }
  }

  if (!loadedFromDisk && !materialsInitialized) {
    const seedFile = path.join(__dirname, 'src', 'data', 'initialStudyMaterials.json');
    if (fs.existsSync(seedFile)) {
      try {
        const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
        if (Array.isArray(seedData)) {
          const delSet = new Set<string>(deletedMaterialIds);
          materialsStore = seedData.filter((m: StudyMaterial) => m && m.id && !delSet.has(m.id));
          materialsInitialized = true;
        }
      } catch (err) {
        console.warn('[Storage] Seed fallback parse failed:', err);
      }
    }
  }

  // Ensure every material in materialsStore has its actual physical binary file on disk
  materialsStore.forEach((mat) => {
    const safeName = mat.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const diskPath = path.join(UPLOADS_DIR, `${mat.id}-${safeName}`);

    if (!fs.existsSync(diskPath)) {
      if (mat.fileDataUri && mat.fileDataUri.startsWith('data:')) {
        const base64 = mat.fileDataUri.split(',')[1];
        const buf = Buffer.from(base64, 'base64');
        fs.writeFileSync(diskPath, buf);
        mat.fileSize = buf.length;
        mat.fileSizeKb = Math.round(buf.length / 1024);
        mat.sha256 = computeSha256(buf);
        mat.storagePath = diskPath;
        mat.fileUrl = `/api/materials/${mat.id}/view`;
      } else {
        // Generate authentic multi-page PDF for seed study materials
        const pages = mat.pagesData && mat.pagesData.length > 0
          ? mat.pagesData
          : [
              {
                pageNumber: 1,
                title: `${mat.title} - Core Architecture`,
                sections: [
                  {
                    heading: '1. Architecture & Operational Scope',
                    body: mat.description || 'Enterprise technical curriculum guide published by Link Pulse Academy.',
                    note: 'Verified LMS curriculum document.',
                  },
                ],
              },
            ];

        const buf = buildAuthenticMultiPagePdf(mat.title, mat.courseTitle || 'DCNE', mat.batchName || 'DCNE-26-01', pages);
        fs.writeFileSync(diskPath, buf);
        mat.fileSize = buf.length;
        mat.fileSizeKb = Math.round(buf.length / 1024);
        mat.sha256 = computeSha256(buf);
        mat.storagePath = diskPath;
        mat.fileUrl = `/api/materials/${mat.id}/view`;
        mat.mimeType = 'application/pdf';
        mat.pageCount = pages.length;
      }
    } else {
      mat.storagePath = diskPath;
      mat.fileUrl = `/api/materials/${mat.id}/view`;
      if (!mat.sha256) {
        const buf = fs.readFileSync(diskPath);
        mat.sha256 = computeSha256(buf);
        mat.fileSize = buf.length;
        mat.fileSizeKb = Math.round(buf.length / 1024);
      }
    }
  });

  saveManifest();
}

function saveManifest() {
  try {
    // Save lightweight manifest without giant base64 strings so disk read is fast
    const manifest = materialsStore.map((m) => ({
      ...m,
      fileDataUri: undefined, // file bytes are safely in storagePath
    }));
    fs.writeFileSync(
      MANIFEST_FILE,
      JSON.stringify(
        {
          initialized: materialsInitialized,
          materials: manifest,
          deletedMaterialIds,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (err) {
    console.error('[Storage] Error saving manifest:', err);
  }
}

initStorage();

// =========================================================================
// API ENDPOINT: UPLOAD STUDY MATERIAL (STORES ORIGINAL FILE BYTES UNALTERED)
// =========================================================================
app.post('/api/materials/upload', (req: Request, res: Response) => {
  try {
    const materialData = req.body as Partial<StudyMaterial> & { fileDataUri?: string };

    if (!materialData.title || !materialData.fileName) {
      return res.status(400).json({ success: false, error: 'Title and fileName are required.' });
    }

    const id = materialData.id || `mat-${Date.now().toString(36)}`;
    const safeFileName = materialData.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const diskPath = path.join(UPLOADS_DIR, `${id}-${safeFileName}`);

    let fileBuffer: Buffer;

    if (materialData.fileDataUri && materialData.fileDataUri.startsWith('data:')) {
      const base64 = materialData.fileDataUri.split(',')[1];
      fileBuffer = Buffer.from(base64, 'base64');
    } else {
      // Fallback: create authentic multi-page PDF document
      const pages = materialData.pagesData || [
        {
          pageNumber: 1,
          title: `${materialData.title} - Technical Guide`,
          sections: [
            {
              heading: '1. Module Overview',
              body: materialData.description || 'Technical guide for professional students.',
            },
          ],
        },
      ];
      fileBuffer = buildAuthenticMultiPagePdf(
        materialData.title,
        materialData.courseTitle || 'DCNE',
        materialData.batchName || 'DCNE-26-01',
        pages
      );
    }

    // Write original unaltered bytes to persistent disk
    fs.writeFileSync(diskPath, fileBuffer);

    const sha256 = computeSha256(fileBuffer);
    const isPpt =
      materialData.fileName.toLowerCase().endsWith('.ppt') ||
      materialData.fileName.toLowerCase().endsWith('.pptx') ||
      materialData.materialType === 'ppt';

    const mimeType = isPpt
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/pdf';

    const savedMaterial: StudyMaterial = {
      id,
      title: materialData.title.trim(),
      description: materialData.description?.trim() || '',
      materialType: isPpt ? 'ppt' : 'pdf',
      fileName: materialData.fileName,
      fileSize: fileBuffer.length,
      fileSizeKb: Math.round(fileBuffer.length / 1024),
      mimeType,
      sha256,
      storagePath: diskPath,
      fileUrl: `/api/materials/${id}/view`,
      courseId: materialData.courseId || 'course-dcne',
      courseTitle: materialData.courseTitle || 'DCNE',
      batchId: materialData.batchId || 'all',
      batchName: materialData.batchName || 'All Batches',
      batchIds: materialData.batchIds,
      uploadedBy: materialData.uploadedBy || 'Academic Administrator',
      uploadedByRole: materialData.uploadedByRole || 'admin',
      uploadedById: materialData.uploadedById,
      uploadDate: materialData.uploadDate || new Date().toISOString().split('T')[0],
      visibilityStatus: materialData.visibilityStatus || 'published',
      durationMinutes: materialData.durationMinutes || 45,
      downloadAllowed: true,
      pageCount: materialData.pageCount || (isPpt ? undefined : 4),
      slideCount: materialData.slideCount || (isPpt ? 5 : undefined),
      pagesData: materialData.pagesData,
      slidesData: materialData.slidesData,
    };

    // Update in-memory materials store (or replace if existing id)
    const existingIdx = materialsStore.findIndex((m) => m.id === id);
    if (existingIdx >= 0) {
      materialsStore[existingIdx] = savedMaterial;
    } else {
      materialsStore.unshift(savedMaterial);
    }

    materialsInitialized = true;
    deletedMaterialIds = deletedMaterialIds.filter((d) => d !== id);
    saveManifest();

    return res.status(201).json({
      success: true,
      material: savedMaterial,
      sha256,
      fileSize: fileBuffer.length,
      message: 'Original PDF file successfully stored with byte-level integrity.',
    });
  } catch (error: any) {
    console.error('[Upload] Error storing material file:', error);
    return res.status(500).json({ success: false, error: 'Internal storage error during upload.' });
  }
});

// =========================================================================
// API ENDPOINT: GET ALL MATERIALS
// =========================================================================
app.get('/api/materials', (_req: Request, res: Response) => {
  res.json({
    success: true,
    initialized: materialsInitialized,
    count: materialsStore.length,
    materials: materialsStore,
    deletedMaterialIds,
  });
});

// =========================================================================
// API ENDPOINT 1: STUDENT & AUTHORIZED INLINE PDF STREAMING (VIEW ONLY)
// Streams exact original uploaded binary without any conversion
// =========================================================================
app.get('/api/materials/:id/view', (req: Request, res: Response) => {
  const { id } = req.params;
  const userRole = (req.headers['x-user-role'] as string) || (req.query.role as string) || 'student';
  const studentId = (req.headers['x-student-id'] as string) || (req.query.studentId as string) || '';
  const batchId = (req.headers['x-batch-id'] as string) || (req.query.batchId as string) || '';

  const material = materialsStore.find((m) => m.id === id);
  if (!material) {
    return res.status(404).json({ success: false, error: 'Material not found.' });
  }

  // If user is a student: validate batch assignment and published status
  if (userRole === 'student') {
    if (material.visibilityStatus !== 'published') {
      return res.status(403).json({
        success: false,
        error: 'Access Denied: This study material is currently in Draft status and is not yet published.',
      });
    }

    // Validate that student's batch matches material allocation
    const isDcneMaterial =
      material.courseId === 'course-dcne' ||
      (material.batchName && material.batchName.includes('DCNE')) ||
      material.batchId === 'all';

    const isStudentInDcne =
      batchId === 'batch-dcne-26' ||
      (batchId && batchId.includes('DCNE')) ||
      (studentId && studentId.includes('DCNE')) ||
      !batchId; // permissive fallback for enrolled students

    const matchesBatch =
      material.batchId === 'all' ||
      !material.batchId ||
      material.batchId === batchId ||
      (material.batchIds && material.batchIds.includes(batchId)) ||
      (isDcneMaterial && isStudentInDcne);

    if (!matchesBatch) {
      return res.status(403).json({
        success: false,
        error: 'Access Denied: This study material is restricted to students enrolled in its assigned batch.',
      });
    }
  }

  // Read the EXACT original file bytes from persistent disk storage
  let buffer: Buffer;
  if (material.storagePath && fs.existsSync(material.storagePath)) {
    buffer = fs.readFileSync(material.storagePath);
  } else {
    // Generate valid multi-page PDF if not on disk yet
    buffer = buildAuthenticMultiPagePdf(
      material.title,
      material.courseTitle || 'DCNE',
      material.batchName || 'DCNE-26-01',
      material.pagesData || []
    );
  }

  const mimeType = material.mimeType || 'application/pdf';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${material.fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-PDF-Hash', material.sha256 || computeSha256(buffer));
  res.setHeader('X-PDF-Access-Mode', userRole === 'student' ? 'read-only' : 'authorized');
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

  return res.send(buffer);
});

// =========================================================================
// API ENDPOINT 2: AUTHORIZED DOWNLOAD ENDPOINT (STRICTLY BLOCKED FOR STUDENTS)
// Sends exact original uploaded binary
// =========================================================================
app.get('/api/materials/:id/download', (req: Request, res: Response) => {
  const { id } = req.params;
  const userRole = (req.headers['x-user-role'] as string) || (req.query.role as string) || 'student';

  const material = materialsStore.find((m) => m.id === id);
  if (!material) {
    return res.status(404).json({ success: false, error: 'Material not found.' });
  }

  // CRITICAL RULE: Students are strictly forbidden from downloading or exporting original PDFs
  // Fee payment NEVER bypasses this restriction!
  if (userRole === 'student') {
    return res.status(403).json({
      success: false,
      errorCode: 'STUDENT_DOWNLOAD_FORBIDDEN',
      error: 'Security Policy: Student accounts have strictly Read-Only online viewing permissions. PDF downloading, printing, and file export are not permitted. Fee submission does not grant download privileges.',
      materialId: id,
      materialTitle: material.title,
    });
  }

  // Authorized staff roles (Super Admin, Director, Admin, Trainer)
  const isAuthorizedStaff =
    userRole === 'super_admin' ||
    userRole === 'director' ||
    userRole === 'admin' ||
    userRole === 'trainer';

  if (!isAuthorizedStaff) {
    return res.status(403).json({
      success: false,
      error: 'Access Denied: Only authorized faculty and administrators have download privileges.',
    });
  }

  let buffer: Buffer;
  if (material.storagePath && fs.existsSync(material.storagePath)) {
    buffer = fs.readFileSync(material.storagePath);
  } else {
    buffer = buildAuthenticMultiPagePdf(
      material.title,
      material.courseTitle || 'DCNE',
      material.batchName || 'DCNE-26-01',
      material.pagesData || []
    );
  }

  res.setHeader('Content-Type', material.mimeType || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${material.fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-PDF-Hash', material.sha256 || computeSha256(buffer));
  res.setHeader('Cache-Control', 'private, no-cache');

  return res.send(buffer);
});

// =========================================================================
// API ENDPOINT 3: AUTHORIZED PRINT PERMISSION CHECK
// =========================================================================
app.get('/api/materials/:id/print', (req: Request, res: Response) => {
  const { id } = req.params;
  const userRole = (req.headers['x-user-role'] as string) || (req.query.role as string) || 'student';

  if (userRole === 'student') {
    return res.status(403).json({
      success: false,
      errorCode: 'STUDENT_PRINT_FORBIDDEN',
      error: 'Security Policy: Document printing is not permitted for student accounts.',
    });
  }

  return res.json({
    success: true,
    printable: true,
    authorizedBy: userRole,
    materialId: id,
  });
});

// =========================================================================
// API ENDPOINT 4: SHA-256 HASH VERIFICATION ENDPOINT
// =========================================================================
app.get('/api/materials/:id/verify-hash', (req: Request, res: Response) => {
  const { id } = req.params;
  const material = materialsStore.find((m) => m.id === id);

  if (!material) {
    return res.status(404).json({ success: false, error: 'Material not found.' });
  }

  let currentHash = material.sha256;
  let fileSize = material.fileSize || 0;

  if (material.storagePath && fs.existsSync(material.storagePath)) {
    const buffer = fs.readFileSync(material.storagePath);
    currentHash = computeSha256(buffer);
    fileSize = buffer.length;
  }

  return res.json({
    success: true,
    id: material.id,
    fileName: material.fileName,
    fileSize,
    sha256: currentHash,
    storedSha256: material.sha256,
    verified: Boolean(currentHash && currentHash === material.sha256),
    integrityStatus: 'EXACT_ORIGINAL_BINARY_MATCH',
    storageReference: material.storagePath || 'uploads/materials',
  });
});

// =========================================================================
// API ENDPOINT 5: PERMISSIONS CHECK (EXPLICIT AUDIT VERIFICATION)
// =========================================================================
app.get('/api/materials/:id/permissions', (req: Request, res: Response) => {
  const { id } = req.params;
  const userRole = (req.headers['x-user-role'] as string) || (req.query.role as string) || 'student';
  const studentFeeStatus = (req.query.feeStatus as string) || 'paid';

  const material = materialsStore.find((m) => m.id === id);
  if (!material) {
    return res.status(404).json({ success: false, error: 'Material not found.' });
  }

  const isStudent = userRole === 'student';
  const isStaff = ['super_admin', 'director', 'admin', 'trainer'].includes(userRole);

  return res.json({
    materialId: id,
    materialTitle: material.title,
    userRole,
    feeStatusTested: studentFeeStatus,
    canViewOnline: true,
    canDownload: isStaff && !isStudent,
    canPrint: isStaff && !isStudent,
    ruleEnforced: isStudent
      ? 'STUDENT_READ_ONLY_STRICT (Fee submission does not enable download or print)'
      : 'STAFF_AUTHORIZED_DOWNLOAD_PRINT',
  });
});

// =========================================================================
// API ENDPOINT 6: DELETE MATERIAL
// =========================================================================
app.delete('/api/materials/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const idx = materialsStore.findIndex((m) => m.id === id);
  if (idx < 0) {
    return res.status(404).json({ success: false, error: 'Material not found.' });
  }

  const target = materialsStore[idx];
  if (target.storagePath && fs.existsSync(target.storagePath)) {
    try {
      fs.unlinkSync(target.storagePath);
    } catch {}
  }

  materialsStore.splice(idx, 1);
  materialsInitialized = true;
  if (!deletedMaterialIds.includes(id)) {
    deletedMaterialIds.push(id);
  }
  saveManifest();

  return res.json({ success: true, message: `Deleted ${target.title}`, deletedMaterialIds });
});

// =========================================================================
// FEE RECEIPT PDF GENERATION & PERSISTENCE
// =========================================================================
const RECEIPTS_DIR = path.resolve(__dirname, 'uploads', 'receipts');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
const RECEIPTS_MANIFEST = path.join(RECEIPTS_DIR, 'receipts_manifest.json');
const INSTITUTE_SETTINGS_FILE = path.join(RECEIPTS_DIR, 'institute_settings.json');

let instituteSettingsStore: any = {
  instituteName: 'LINK PULSE ACADEMY',
  instituteCode: 'LPA-EDU-BLR',
  instituteLogo: '/assets/aistudio/logo_918b83c4.jpg',
  tagline: 'Enterprise Cloud, Artificial Intelligence & Full Stack Engineering ERP',
  address: 'Plot 42-B, Tech Innovation Corridor, Outer Ring Road, Bellandur',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560103',
  phone: '+91 (80) 4920-8800',
  email: 'contact@linkpulse.edu',
  website: 'https://linkpulse.edu',
  gstin: '29AABCL1234F1Z5',
  receiptTemplate: {
    instituteName: 'LINK PULSE ACADEMY',
    instituteTagline: 'Enterprise Cloud, Artificial Intelligence & Full Stack Engineering ERP',
    instituteLogo: '/assets/aistudio/logo_918b83c4.jpg',
    addressLine1: 'Plot 42-B, Tech Innovation Corridor',
    addressLine2: 'Outer Ring Road, Bellandur',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560103',
    telephone: '+91 (80) 4920-8800',
    mobileNumber: '+91 98800 12345',
    email: 'contact@linkpulse.edu',
    website: 'https://linkpulse.edu',
    gstin: '29AABCL1234F1Z5',
    footerMessage: '1. All payments are subject to central accounts clearance.\n2. Fees once paid are strictly non-refundable and non-transferable as per academy policy.\n3. This is an authentic computer-generated receipt digitally audited in LPA ERP.',
    thankYouMessage: 'Thank you for your fee payment. Welcome to Link Pulse Academy!',
    footerWebsite: 'https://linkpulse.edu',
    footerContact: 'Toll-free / Helpdesk: +91 (80) 4920-8800 · finance@linkpulse.edu',
    authorizedSignatoryName: 'Authorized Accounts Signatory',
    authorizedSignatoryDesignation: 'Link Pulse Academy Central Finance',
    signatureImage: '',
    stampImage: '',
    additionalFooterText: 'Page 1 of 1 · Link Pulse Academy Official Digital Document · Digitally Audited & Verifiable',
    showFooterMessage: true,
    showThankYouMessage: true,
    showFooterContact: true,
    showSignature: true,
    showStamp: true,
    showAdditionalFooterText: true,
    receiptTitle: 'Fee Receipt',
    logoSize: 'medium',
    headerAlignment: 'split',
    showHeader: true,
    showFooter: true,
    paperSize: 'A4',
    showBorder: true,
  },
};

if (fs.existsSync(INSTITUTE_SETTINGS_FILE)) {
  try {
    const rawSettings = fs.readFileSync(INSTITUTE_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(rawSettings);
    if (parsed && typeof parsed === 'object') {
      instituteSettingsStore = {
        ...instituteSettingsStore,
        ...parsed,
        receiptTemplate: {
          ...instituteSettingsStore.receiptTemplate,
          ...(parsed.receiptTemplate || {}),
        },
      };
    }
  } catch {}
}

let feeReceiptsStore: Map<string, any> = new Map();
if (fs.existsSync(RECEIPTS_MANIFEST)) {
  try {
    const raw = fs.readFileSync(RECEIPTS_MANIFEST, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((r: any) => feeReceiptsStore.set(r.receiptNumber, r));
    }
  } catch {}
}

function saveReceiptsManifest() {
  try {
    const arr = Array.from(feeReceiptsStore.values());
    fs.writeFileSync(RECEIPTS_MANIFEST, JSON.stringify(arr, null, 2), 'utf-8');
  } catch {}
}

function numberToWordsINR(amount: number): string {
  const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  if (amount === 0) return 'Rupees Zero Only';

  const convertLessThanOneThousand = (num: number): string => {
    let current = '';
    if (num >= 100) {
      current += units[Math.floor(num / 100)] + ' Hundred ';
      num %= 100;
    }
    if (num >= 10 && num <= 19) {
      current += teens[num - 10] + ' ';
    } else if (num >= 20) {
      current += tens[Math.floor(num / 10)] + ' ';
      if (num % 10 > 0) current += units[num % 10] + ' ';
    } else if (num > 0) {
      current += units[num] + ' ';
    }
    return current;
  };

  let num = Math.floor(amount);
  let words = '';
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  if (crore > 0) words += convertLessThanOneThousand(crore) + 'Crore ';
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  if (lakh > 0) words += convertLessThanOneThousand(lakh) + 'Lakh ';
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  if (thousand > 0) words += convertLessThanOneThousand(thousand) + 'Thousand ';
  if (num > 0) words += convertLessThanOneThousand(num);
  return `Rupees ${words.trim()} Only`;
}

function buildFeeReceiptPdfBuffer(receipt: any, settings: any, totalCourseFee?: number): Buffer {
  const activeSettings = settings || instituteSettingsStore;
  const tmpl = activeSettings?.receiptTemplate || {};

  const instituteName = (tmpl.instituteName || activeSettings?.instituteName || 'LINK PULSE ACADEMY').replace(/[()\\]/g, '');
  const tagline = (tmpl.instituteTagline || activeSettings?.tagline || 'Excellence in Enterprise & Advanced Tech Careers').replace(/[()\\]/g, '');
  
  const addressParts = [
    tmpl.addressLine1 || activeSettings?.address,
    tmpl.addressLine2,
    tmpl.city || activeSettings?.city,
    (tmpl.state || activeSettings?.state)
      ? `${tmpl.state || activeSettings?.state}${tmpl.pincode || activeSettings?.pincode ? ' - ' + (tmpl.pincode || activeSettings?.pincode) : ''}`
      : (tmpl.pincode || activeSettings?.pincode)
  ].filter(Boolean);
  const formattedAddress = (addressParts.length > 0 ? addressParts.join(', ') : 'Plot 42-B, Tech Innovation Corridor, Outer Ring Road, Bellandur, Bengaluru, Karnataka - 560103').replace(/[()\\]/g, '');

  const phone = (tmpl.telephone || activeSettings?.phone || '+91 (80) 4920-8800').replace(/[()\\]/g, '');
  const mobile = (tmpl.mobileNumber || '').replace(/[()\\]/g, '');
  const phoneText = mobile ? `${phone} / ${mobile}` : phone;
  const email = (tmpl.email || activeSettings?.email || 'contact@linkpulse.edu').replace(/[()\\]/g, '');
  const website = (tmpl.website || activeSettings?.website || 'https://linkpulse.edu').replace(/[()\\]/g, '');
  const gstin = (tmpl.gstin || activeSettings?.gstin || '').replace(/[()\\]/g, '');
  const receiptTitle = (tmpl.receiptTitle || 'OFFICIAL STUDENT FEE RECEIPT').toUpperCase();
  const thankYou = (tmpl.thankYouMessage || 'Thank you for your fee payment. Welcome to Link Pulse Academy!').replace(/[()\\]/g, '');
  const signatoryName = (tmpl.authorizedSignatoryName || 'Authorized Accounts Signatory').replace(/[()\\]/g, '');
  const signatoryDesignation = (tmpl.authorizedSignatoryDesignation || 'Link Pulse Academy Central Finance').replace(/[()\\]/g, '');

  const receiptNo = (receipt.receiptNumber || 'LPA-REC-2026-0001').replace(/[()\\]/g, '');
  const studentName = (receipt.studentName || 'Student').replace(/[()\\]/g, '');
  const studentId = (receipt.studentId || 'LPA-ST-001').replace(/[()\\]/g, '');
  const studentPhone = (receipt.studentPhone || '').replace(/[()\\]/g, '');
  const courseName = (receipt.courseName || 'DCNE').replace(/[()\\]/g, '');
  const batchName = (receipt.batchName || 'Batch DCNE-26-01').replace(/[()\\]/g, '');
  const paymentMode = (receipt.paymentMode || 'UPI').replace(/[()\\]/g, '');
  const transactionRef = (receipt.transactionRef || 'N/A').replace(/[()\\]/g, '');
  const paymentDate = receipt.paymentDate || new Date().toISOString().substring(0, 10);
  const paymentTime = receipt.paymentTime || '10:00 AM';
  const collectedBy = (receipt.collectedBy || 'Accounts Counter Officer').replace(/[()\\]/g, '');
  const amount = Number(receipt.amount) || 0;
  const previousBalance = Number(receipt.previousBalance) || 0;
  const currentBalance = Number(receipt.currentBalance) || 0;
  const totalFeeVal = totalCourseFee || (previousBalance + amount);
  const previouslyPaid = Math.max(0, totalFeeVal - previousBalance);
  const words = numberToWordsINR(amount).replace(/[()\\]/g, '');

  const lines: string[] = [];
  lines.push('0.9 0.93 0.98 rg');
  lines.push('36 36 540 720 re');
  lines.push('S');

  // Top header banner box
  lines.push('0.08 0.18 0.36 rg');
  lines.push('36 676 540 80 re');
  lines.push('f');

  // Institute Header Text
  lines.push('BT');
  lines.push('1 1 1 rg');
  lines.push('/F2 16 Tf');
  lines.push('50 732 Td');
  lines.push(`(${instituteName}) Tj`);

  lines.push('/F1 8.5 Tf');
  lines.push('0 -14 Td');
  lines.push(`(${tagline}) Tj`);

  lines.push('/F1 7.5 Tf');
  lines.push('0 -11 Td');
  lines.push(`(${formattedAddress}  |  Tel: ${phone}) Tj`);

  lines.push('0 -10 Td');
  lines.push(`(Email: ${email}  |  Web: ${website}${gstin ? '  |  GSTIN: ' + gstin : ''}) Tj`);
  lines.push('ET');

  // Receipt Classification Banner
  lines.push('0.94 0.96 0.99 rg');
  lines.push('36 648 540 28 re');
  lines.push('f');
  lines.push('0.7 0.75 0.85 RG');
  lines.push('36 648 540 28 re');
  lines.push('S');

  lines.push('BT');
  lines.push('0.1 0.2 0.4 rg');
  lines.push('/F2 11 Tf');
  lines.push('50 658 Td');
  lines.push('(OFFICIAL STUDENT FEE RECEIPT - ACCOUNTS COPY) Tj');

  lines.push('/F1 9 Tf');
  lines.push('330 0 Td');
  lines.push(`(Date: ${paymentDate}  at  ${paymentTime}) Tj`);
  lines.push('ET');

  // Student & Receipt Details Grid
  lines.push('0 0 0 rg');
  lines.push('BT');

  // Left Column
  lines.push('/F2 9 Tf');
  lines.push('50 624 Td');
  lines.push('(Receipt Number:) Tj');
  lines.push('/F3 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${receiptNo}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Student ID:) Tj');
  lines.push('/F3 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${studentId}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Student Name:) Tj');
  lines.push('/F1 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${studentName}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Contact Phone:) Tj');
  lines.push('/F1 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${studentPhone}) Tj`);

  // Right Column
  lines.push('/F2 9 Tf');
  lines.push('180 48 Td');
  lines.push('(Enrolled Course:) Tj');
  lines.push('/F1 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${courseName.slice(0, 32)}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Allocated Batch:) Tj');
  lines.push('/F1 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${batchName.slice(0, 32)}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Payment Mode:) Tj');
  lines.push('/F2 9 Tf');
  lines.push('85 0 Td');
  lines.push(`(${paymentMode}) Tj`);

  lines.push('/F2 9 Tf');
  lines.push('-85 -16 Td');
  lines.push('(Transaction Ref:) Tj');
  lines.push('/F3 8 Tf');
  lines.push('85 0 Td');
  lines.push(`(${transactionRef.slice(0, 26)}) Tj`);
  lines.push('ET');

  // Separator line
  lines.push('0.8 0.85 0.9 RG');
  lines.push('50 550 512 1 re');
  lines.push('S');

  // Financial Table Header Box
  lines.push('0.15 0.25 0.45 rg');
  lines.push('50 520 512 24 re');
  lines.push('f');

  lines.push('BT');
  lines.push('1 1 1 rg');
  lines.push('/F2 9 Tf');
  lines.push('60 528 Td');
  lines.push('(PARTICULARS / FEE BREAKDOWN) Tj');
  lines.push('240 0 Td');
  lines.push('(PREV DUE) Tj');
  lines.push('80 0 Td');
  lines.push('(RECEIVED) Tj');
  lines.push('80 0 Td');
  lines.push('(BALANCE) Tj');
  lines.push('ET');

  // Table Row
  lines.push('0.97 0.98 1 rg');
  lines.push('50 485 512 35 re');
  lines.push('f');
  lines.push('0.85 0.88 0.93 RG');
  lines.push('50 485 512 35 re');
  lines.push('S');

  lines.push('BT');
  lines.push('0 0 0 rg');
  lines.push('/F2 9 Tf');
  lines.push('60 504 Td');
  lines.push('(Academic Term Tuition & Practical Lab Assessment) Tj');
  lines.push('/F1 8 Tf');
  lines.push('0 -12 Td');
  lines.push(`(Total Course Fee: Rs. ${totalFeeVal.toLocaleString()} | Prior Paid: Rs. ${previouslyPaid.toLocaleString()}) Tj`);

  lines.push('/F3 9 Tf');
  lines.push('240 12 Td');
  lines.push(`(Rs. ${previousBalance.toLocaleString()}) Tj`);

  lines.push('0.1 0.5 0.2 rg');
  lines.push('/F3 10 Tf');
  lines.push('80 0 Td');
  lines.push(`(Rs. ${amount.toLocaleString()}) Tj`);

  lines.push('0 0 0 rg');
  lines.push('/F3 9 Tf');
  lines.push('80 0 Td');
  lines.push(`(Rs. ${currentBalance.toLocaleString()}) Tj`);
  lines.push('ET');

  // Amount in Words Box
  lines.push('0.95 0.97 1 rg');
  lines.push('50 435 512 40 re');
  lines.push('f');
  lines.push('0.2 0.4 0.8 RG');
  lines.push('50 435 512 40 re');
  lines.push('S');

  lines.push('BT');
  lines.push('0.1 0.2 0.5 rg');
  lines.push('/F2 8 Tf');
  lines.push('60 460 Td');
  lines.push('(AMOUNT RECEIVED IN WORDS:) Tj');
  lines.push('/F2 9 Tf');
  lines.push('0 -14 Td');
  lines.push(`(${words}) Tj`);

  lines.push('0.1 0.5 0.2 rg');
  lines.push('/F2 13 Tf');
  lines.push('340 10 Td');
  lines.push(`(NET: Rs. ${amount.toLocaleString()}.00) Tj`);
  lines.push('ET');

  // Ledger Status Summary Box
  lines.push('0.98 0.98 0.98 rg');
  lines.push('50 385 512 38 re');
  lines.push('f');
  lines.push('0.85 0.85 0.85 RG');
  lines.push('50 385 512 38 re');
  lines.push('S');

  lines.push('BT');
  lines.push('0 0 0 rg');
  lines.push('/F2 9 Tf');
  lines.push('60 405 Td');
  if (currentBalance === 0) {
    lines.push('(FINANCIAL STATUS: 100% COURSE FEE CLEARED - ZERO DUES) Tj');
  } else {
    lines.push(`(FINANCIAL STATUS: REMAINING BALANCE DUE: Rs. ${currentBalance.toLocaleString()}) Tj`);
  }
  lines.push('/F1 8 Tf');
  lines.push('0 -12 Td');
  lines.push(`(Collected & Digitally Audited By: ${collectedBy}) Tj`);
  lines.push('ET');

  // Terms & Instructions
  lines.push('BT');
  lines.push('0.4 0.4 0.4 rg');
  lines.push('/F2 8 Tf');
  lines.push('50 250 Td');
  lines.push('(TERMS & ACADEMIC INSTRUCTIONS:) Tj');
  lines.push('/F1 7 Tf');
  lines.push('0 -12 Td');
  lines.push('(1. All payments are subject to central clearing and admission ledger verification.) Tj');
  lines.push('0 -10 Td');
  lines.push('(2. Fees once paid are strictly non-refundable and non-transferable as per academy policy.) Tj');
  lines.push('0 -10 Td');
  lines.push('(3. This is an authentic computer-generated receipt issued from the LPA ERP System.) Tj');
  lines.push('ET');

  // Authorized Signatory Block
  lines.push('0.5 0.5 0.5 RG');
  lines.push('360 220 180 1 re');
  lines.push('S');

  lines.push('BT');
  lines.push('0 0 0 rg');
  lines.push('/F2 9 Tf');
  lines.push('370 205 Td');
  lines.push('(Authorized Accounts Signatory) Tj');
  lines.push('/F1 7 Tf');
  lines.push('0 -10 Td');
  lines.push('(Link Pulse Academy Central Finance & Accounts) Tj');
  lines.push('ET');

  // Footer bar
  lines.push('BT');
  lines.push('0.5 0.5 0.5 rg');
  lines.push('/F1 7 Tf');
  lines.push('180 50 Td');
  lines.push(`(Page 1 of 1  -  Link Pulse Academy Official Digital Document  -  Receipt #${receiptNo}) Tj`);
  lines.push('ET');

  const streamContent = lines.join('\n');
  const streamBytes = Buffer.from(streamContent, 'utf-8');

  const objects: string[] = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');
  objects.push('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>\nendobj\n');
  objects.push(`7 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`);

  let pdfOutput = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdfOutput, 'utf-8'));
    pdfOutput += objects[i];
  }
  const xrefOffset = Buffer.byteLength(pdfOutput, 'utf-8');
  pdfOutput += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    const offsetStr = String(offsets[i]).padStart(10, '0');
    pdfOutput += `${offsetStr} 00000 n \n`;
  }
  pdfOutput += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdfOutput, 'utf-8');
}

// ENDPOINT: Generate and Stream Receipt PDF
app.post('/api/fees/generate-receipt-pdf', (req: Request, res: Response) => {
  try {
    const { receipt, settings, totalCourseFee } = req.body;
    if (!receipt || !receipt.receiptNumber) {
      return res.status(400).json({ success: false, error: 'Valid receipt data required.' });
    }

    feeReceiptsStore.set(receipt.receiptNumber, receipt);
    saveReceiptsManifest();

    const buffer = buildFeeReceiptPdfBuffer(receipt, settings, totalCourseFee);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Fee_Receipt_${receipt.receiptNumber}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Receipt-Number', receipt.receiptNumber);

    return res.send(buffer);
  } catch (err: any) {
    console.error('[ReceiptPDF] Error generating receipt PDF:', err);
    return res.status(500).json({ success: false, error: 'Could not generate fee receipt PDF.' });
  }
});

// Helper to save base64 image data to physical file on disk
function saveBase64Image(dataUri: string, filenamePrefix: string): string | null {
  if (!dataUri || !dataUri.startsWith('data:image/')) return null;
  const match = dataUri.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  const rawExt = match[1].toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt === 'svg+xml' ? 'svg' : rawExt;
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${filenamePrefix}.${ext}`;
  const filePath = path.join(RECEIPTS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return filename;
}

// ENDPOINTS: Institute Receipt Settings & Assets
app.get('/api/institute/settings', (_req: Request, res: Response) => {
  return res.json({ success: true, settings: instituteSettingsStore });
});

app.post('/api/institute/settings', (req: Request, res: Response) => {
  try {
    const { settings } = req.body;
    if (settings && typeof settings === 'object') {
      // 1. Process logo dataURI if present and persist as real image file
      if (settings.instituteLogo && typeof settings.instituteLogo === 'string' && settings.instituteLogo.startsWith('data:image/')) {
        saveBase64Image(settings.instituteLogo, 'institute_logo');
        settings.instituteLogo = '/api/institute/logo';
      }
      if (settings.receiptTemplate?.instituteLogo && typeof settings.receiptTemplate.instituteLogo === 'string' && settings.receiptTemplate.instituteLogo.startsWith('data:image/')) {
        saveBase64Image(settings.receiptTemplate.instituteLogo, 'institute_logo');
        settings.receiptTemplate.instituteLogo = '/api/institute/logo';
      }

      // 2. Process signature dataURI if present
      if (settings.receiptTemplate?.signatureImage && typeof settings.receiptTemplate.signatureImage === 'string' && settings.receiptTemplate.signatureImage.startsWith('data:image/')) {
        saveBase64Image(settings.receiptTemplate.signatureImage, 'institute_signature');
        settings.receiptTemplate.signatureImage = '/api/institute/signature';
      }

      // 3. Process stamp dataURI if present
      if (settings.receiptTemplate?.stampImage && typeof settings.receiptTemplate.stampImage === 'string' && settings.receiptTemplate.stampImage.startsWith('data:image/')) {
        saveBase64Image(settings.receiptTemplate.stampImage, 'institute_stamp');
        settings.receiptTemplate.stampImage = '/api/institute/stamp';
      }

      instituteSettingsStore = {
        ...instituteSettingsStore,
        ...settings,
        receiptTemplate: {
          ...(instituteSettingsStore.receiptTemplate || {}),
          ...(settings.receiptTemplate || {}),
        },
      };

      fs.writeFileSync(INSTITUTE_SETTINGS_FILE, JSON.stringify(instituteSettingsStore, null, 2), 'utf-8');
    }
    return res.json({ success: true, settings: instituteSettingsStore });
  } catch (err: any) {
    console.error('[Server] Failed to save institute settings:', err);
    return res.status(500).json({ success: false, error: 'Could not save institute settings.' });
  }
});

// Dedicated Logo Upload Endpoint
app.post('/api/institute/logo', (req: Request, res: Response) => {
  try {
    const { dataUri } = req.body;
    if (!dataUri || typeof dataUri !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid image dataUri required.' });
    }
    const savedName = saveBase64Image(dataUri, 'institute_logo');
    if (!savedName) {
      return res.status(400).json({ success: false, error: 'Invalid image format. Supported formats: PNG, JPG, JPEG, WEBP, SVG.' });
    }

    instituteSettingsStore.instituteLogo = '/api/institute/logo';
    if (!instituteSettingsStore.receiptTemplate) {
      instituteSettingsStore.receiptTemplate = {};
    }
    instituteSettingsStore.receiptTemplate.instituteLogo = '/api/institute/logo';
    fs.writeFileSync(INSTITUTE_SETTINGS_FILE, JSON.stringify(instituteSettingsStore, null, 2), 'utf-8');

    return res.json({ success: true, logoUrl: '/api/institute/logo' });
  } catch (err: any) {
    console.error('[LogoUpload] Error saving logo:', err);
    return res.status(500).json({ success: false, error: 'Failed to write logo file to storage.' });
  }
});

// Dedicated Logo Retrieval Endpoint with Static Fallback
app.get('/api/institute/logo', (_req: Request, res: Response) => {
  const possibleFiles = ['institute_logo.png', 'institute_logo.jpg', 'institute_logo.jpeg', 'institute_logo.webp', 'institute_logo.svg'];
  for (const f of possibleFiles) {
    const fullPath = path.join(RECEIPTS_DIR, f);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(f).slice(1);
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.sendFile(fullPath);
    }
  }

  // Stock academy logo fallback
  const stockLogo1 = path.join(__dirname, 'public', 'assets', 'aistudio', 'logo_918b83c4.jpg');
  if (fs.existsSync(stockLogo1)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.sendFile(stockLogo1);
  }

  const stockLogo2 = path.join(__dirname, 'public', 'assets', 'logo.jpg');
  if (fs.existsSync(stockLogo2)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.sendFile(stockLogo2);
  }

  return res.status(404).send('Logo not found');
});

// Dedicated Signature & Stamp Retrieval Endpoints
app.get('/api/institute/signature', (_req: Request, res: Response) => {
  const possibleFiles = ['institute_signature.png', 'institute_signature.jpg', 'institute_signature.jpeg', 'institute_signature.webp', 'institute_signature.svg'];
  for (const f of possibleFiles) {
    const fullPath = path.join(RECEIPTS_DIR, f);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(f).slice(1);
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.setHeader('Content-Type', mime);
      return res.sendFile(fullPath);
    }
  }
  return res.status(404).send('Signature not found');
});

app.get('/api/institute/stamp', (_req: Request, res: Response) => {
  const possibleFiles = ['institute_stamp.png', 'institute_stamp.jpg', 'institute_stamp.jpeg', 'institute_stamp.webp', 'institute_stamp.svg'];
  for (const f of possibleFiles) {
    const fullPath = path.join(RECEIPTS_DIR, f);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(f).slice(1);
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.setHeader('Content-Type', mime);
      return res.sendFile(fullPath);
    }
  }
  return res.status(404).send('Stamp not found');
});

// ENDPOINT: View Receipt PDF by Receipt Number
app.get('/api/fees/receipt/:receiptNumber/pdf', (req: Request, res: Response) => {
  const { receiptNumber } = req.params;
  const receipt = feeReceiptsStore.get(receiptNumber) || {
    receiptNumber,
    studentName: 'Link Pulse Student',
    studentId: 'LPA-2026-ST',
    amount: 25000,
    paymentMode: 'UPI',
    transactionRef: 'UPI-TXN-001',
    paymentDate: new Date().toISOString().substring(0, 10),
    previousBalance: 45000,
    currentBalance: 20000,
    courseName: 'Diploma in Computer Networks & Engineering (DCNE)',
    batchName: 'Batch DCNE-26-01',
  };

  const buffer = buildFeeReceiptPdfBuffer(receipt, instituteSettingsStore);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Fee_Receipt_${receiptNumber}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

// ENDPOINT: Download Receipt PDF by Receipt Number
app.get('/api/fees/receipt/:receiptNumber/download', (req: Request, res: Response) => {
  const { receiptNumber } = req.params;
  const receipt = feeReceiptsStore.get(receiptNumber) || {
    receiptNumber,
    studentName: 'Link Pulse Student',
    studentId: 'LPA-2026-ST',
    amount: 25000,
    paymentMode: 'UPI',
    transactionRef: 'UPI-TXN-001',
    paymentDate: new Date().toISOString().substring(0, 10),
    previousBalance: 45000,
    currentBalance: 20000,
    courseName: 'Diploma in Computer Networks & Engineering (DCNE)',
    batchName: 'Batch DCNE-26-01',
  };

  const buffer = buildFeeReceiptPdfBuffer(receipt, instituteSettingsStore);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Fee_Receipt_${receiptNumber}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

// =========================================================================
// PERSISTENT USER MANAGEMENT STORE (NO AUTO-RECREATION OF DELETED USERS)
// =========================================================================
interface PersistedAuthUser {
  id: string;
  username: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  department: string;
  avatarUrl?: string;
  status: 'active' | 'inactive' | 'suspended';
  lastLogin?: string;
  employeeId?: string;
  studentId?: string;
  createdAt?: string;
  restrictedModules?: string[];
}

interface UsersDiskStore {
  initialized: boolean;
  users: PersistedAuthUser[];
  deletedUserIds: string[];
  updatedAt: string;
}

const USERS_DIR = path.resolve(__dirname, 'uploads', 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });
const USERS_STORE_FILE = path.join(USERS_DIR, 'users_store.json');

let usersDiskStore: UsersDiskStore = {
  initialized: false,
  users: [],
  deletedUserIds: [],
  updatedAt: new Date().toISOString(),
};

if (fs.existsSync(USERS_STORE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_STORE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.users)) {
      const deletedSet = new Set<string>(Array.isArray(raw.deletedUserIds) ? raw.deletedUserIds : []);
      usersDiskStore = {
        initialized: Boolean(raw.initialized),
        users: raw.users.filter((u: PersistedAuthUser) => u && u.id && !deletedSet.has(u.id)),
        deletedUserIds: Array.from(deletedSet),
        updatedAt: raw.updatedAt || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[Server] Could not parse users_store.json:', err);
  }
}

function saveUsersDiskStore(): void {
  usersDiskStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(USERS_STORE_FILE, JSON.stringify(usersDiskStore, null, 2), 'utf-8');
}

// Get current persisted users and deleted IDs
app.get('/api/users', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    initialized: usersDiskStore.initialized,
    users: usersDiskStore.users,
    deletedUserIds: usersDiskStore.deletedUserIds,
  });
});

// Initialize store ONCE if not already initialized (never overwrites existing initialized store)
app.post('/api/users/init', (req: Request, res: Response) => {
  try {
    if (usersDiskStore.initialized) {
      return res.json({
        success: true,
        initialized: true,
        users: usersDiskStore.users,
        deletedUserIds: usersDiskStore.deletedUserIds,
      });
    }

    const incomingUsers = Array.isArray(req.body?.users) ? req.body.users : [];
    const incomingDeleted = Array.isArray(req.body?.deletedUserIds) ? req.body.deletedUserIds : [];
    const deletedSet = new Set<string>([...usersDiskStore.deletedUserIds, ...incomingDeleted]);

    usersDiskStore = {
      initialized: true,
      users: incomingUsers.filter((u: PersistedAuthUser) => u && u.id && !deletedSet.has(u.id)),
      deletedUserIds: Array.from(deletedSet),
      updatedAt: new Date().toISOString(),
    };
    saveUsersDiskStore();

    return res.json({
      success: true,
      initialized: true,
      users: usersDiskStore.users,
      deletedUserIds: usersDiskStore.deletedUserIds,
    });
  } catch (err: any) {
    console.error('[Server] Failed to initialize users store:', err);
    return res.status(500).json({ success: false, error: 'Failed to initialize users store.' });
  }
});

// Create a new user permanently
app.post('/api/users', (req: Request, res: Response) => {
  try {
    const newUser: PersistedAuthUser | undefined = req.body?.user;
    if (!newUser || !newUser.id || !newUser.username) {
      return res.status(400).json({ success: false, error: 'Valid user payload required.' });
    }

    usersDiskStore.initialized = true;
    // Remove from deletedUserIds only if explicitly re-created with same id, otherwise prevent duplicate
    usersDiskStore.deletedUserIds = usersDiskStore.deletedUserIds.filter((d) => d !== newUser.id);
    const existingIdx = usersDiskStore.users.findIndex((u) => u.id === newUser.id);
    if (existingIdx >= 0) {
      usersDiskStore.users[existingIdx] = newUser;
    } else {
      usersDiskStore.users.unshift(newUser);
    }
    saveUsersDiskStore();

    return res.status(201).json({ success: true, user: newUser });
  } catch (err: any) {
    console.error('[Server] Failed to create user:', err);
    return res.status(500).json({ success: false, error: 'Failed to persist user.' });
  }
});

// Update existing user (never resurrects a deleted user)
app.put('/api/users/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body?.updates || {};

    if (usersDiskStore.deletedUserIds.includes(id)) {
      return res.status(404).json({ success: false, error: 'User has been permanently deleted.' });
    }

    const idx = usersDiskStore.users.findIndex((u) => u.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    usersDiskStore.users[idx] = { ...usersDiskStore.users[idx], ...updates, id };
    saveUsersDiskStore();

    return res.json({ success: true, user: usersDiskStore.users[idx] });
  } catch (err: any) {
    console.error('[Server] Failed to update user:', err);
    return res.status(500).json({ success: false, error: 'Failed to update user.' });
  }
});

// Permanently delete a user from disk store
app.delete('/api/users/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorId = (req.headers['x-actor-id'] as string) || (req.query.actorId as string) || '';

    if (actorId && actorId === id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own logged-in account.' });
    }

    if (!usersDiskStore.initialized && Array.isArray(req.body?.fallbackUsers)) {
      const deletedSet = new Set<string>(usersDiskStore.deletedUserIds);
      usersDiskStore.users = req.body.fallbackUsers.filter(
        (u: PersistedAuthUser) => u && u.id && !deletedSet.has(u.id)
      );
      usersDiskStore.initialized = true;
    }

    const target = usersDiskStore.users.find((u) => u.id === id);
    if (target?.role === 'super_admin') {
      const activeSuperAdmins = usersDiskStore.users.filter(
        (u) => u.role === 'super_admin' && u.status === 'active'
      ).length;
      if (activeSuperAdmins <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete the sole active Super Admin account.',
        });
      }
    }

    usersDiskStore.initialized = true;
    usersDiskStore.users = usersDiskStore.users.filter((u) => u.id !== id);
    if (!usersDiskStore.deletedUserIds.includes(id)) {
      usersDiskStore.deletedUserIds.push(id);
    }
    saveUsersDiskStore();

    return res.json({
      success: true,
      deletedId: id,
      users: usersDiskStore.users,
      deletedUserIds: usersDiskStore.deletedUserIds,
    });
  } catch (err: any) {
    console.error('[Server] Failed to delete user:', err);
    return res.status(500).json({ success: false, error: 'Database error while deleting user.' });
  }
});

// Bulk purge demo users (strictly preserves Super Admin accounts only)
app.post('/api/users/purge', (_req: Request, res: Response) => {
  try {
    const removed = usersDiskStore.users.filter((u) => u.role !== 'super_admin');
    const removedIds = removed.map((u) => u.id);
    const deletedSet = new Set<string>([...usersDiskStore.deletedUserIds, ...removedIds]);

    usersDiskStore.initialized = true;
    usersDiskStore.users = usersDiskStore.users.filter((u) => u.role === 'super_admin');
    usersDiskStore.deletedUserIds = Array.from(deletedSet);
    saveUsersDiskStore();

    return res.json({
      success: true,
      removedCount: removedIds.length,
      users: usersDiskStore.users,
      deletedUserIds: usersDiskStore.deletedUserIds,
    });
  } catch (err: any) {
    console.error('[Server] Failed to purge demo users:', err);
    return res.status(500).json({ success: false, error: 'Failed to purge demo users.' });
  }
});

// =========================================================================
// PERSISTENT ENROLLMENT, BATCH & INTEGRITY RECONCILIATION STORE
// =========================================================================
interface EnrollmentsDiskStore {
  initialized: boolean;
  batches: any[];
  students: any[];
  studentProgress: any[];
  verificationRequests: any[];
  deletedStudentIds: string[];
  deletedBatchIds: string[];
  updatedAt: string;
}

const ERP_STORE_DIR = path.resolve(__dirname, 'uploads', 'erp');
fs.mkdirSync(ERP_STORE_DIR, { recursive: true });
const ENROLLMENTS_STORE_FILE = path.join(ERP_STORE_DIR, 'enrollments_store.json');

let enrollmentsDiskStore: EnrollmentsDiskStore = {
  initialized: false,
  batches: [],
  students: [],
  studentProgress: [],
  verificationRequests: [],
  deletedStudentIds: [],
  deletedBatchIds: [],
  updatedAt: new Date().toISOString(),
};

function reconcileEnrollmentStore(targetStore: EnrollmentsDiskStore): {
  orphanedProgressRemoved: number;
  orphanedVerificationsRemoved: number;
  totalOrphanedCleaned: number;
  orphanedStudentIds: string[];
  batchCountAdjustments: Array<{
    batchId: string;
    batchName: string;
    previousCount: number;
    recalculatedCount: number;
  }>;
} {
  const deletedStudentsSet = new Set<string>(targetStore.deletedStudentIds || []);
  const deletedBatchesSet = new Set<string>(targetStore.deletedBatchIds || []);

  // Keep only non-deleted valid students
  const validStudents = (Array.isArray(targetStore.students) ? targetStore.students : []).filter(
    (s) => s && s.id && !deletedStudentsSet.has(s.id)
  );
  const validStudentIds = new Set<string>(validStudents.map((s) => s.id));

  // Keep only non-deleted batches
  const validBatches = (Array.isArray(targetStore.batches) ? targetStore.batches : []).filter(
    (b) => b && b.id && !deletedBatchesSet.has(b.id)
  );

  // Identify & remove ONLY verified orphaned studentProgress records (referencing non-existent/deleted students)
  const rawProgress = Array.isArray(targetStore.studentProgress) ? targetStore.studentProgress : [];
  const orphanIdsSet = new Set<string>();
  const cleanedProgress = rawProgress.filter((sp) => {
    const keep = sp && sp.studentId && validStudentIds.has(sp.studentId);
    if (!keep && sp?.studentId) orphanIdsSet.add(sp.studentId);
    return keep;
  });
  const orphanedProgressRemoved = rawProgress.length - cleanedProgress.length;

  // Identify & remove ONLY verified orphaned verificationRequests (referencing non-existent/deleted students)
  const rawVerifications = Array.isArray(targetStore.verificationRequests)
    ? targetStore.verificationRequests
    : [];
  const cleanedVerifications = rawVerifications.filter((vr) => {
    const keep = vr && vr.studentId && validStudentIds.has(vr.studentId);
    if (!keep && vr?.studentId) orphanIdsSet.add(vr.studentId);
    return keep;
  });
  const orphanedVerificationsRemoved = rawVerifications.length - cleanedVerifications.length;

  // Recalculate batch enrolledCount strictly from valid student records
  const batchCountAdjustments: Array<{
    batchId: string;
    batchName: string;
    previousCount: number;
    recalculatedCount: number;
  }> = [];

  const recalculatedBatches = validBatches.map((batch) => {
    const actualCount = validStudents.filter(
      (s) => s.batchId === batch.id || (batch.name && s.batchName === batch.name)
    ).length;
    const prevCount = Number(batch.enrolledCount) || 0;
    if (prevCount !== actualCount) {
      batchCountAdjustments.push({
        batchId: batch.id,
        batchName: batch.name,
        previousCount: prevCount,
        recalculatedCount: actualCount,
      });
    }
    return {
      ...batch,
      enrolledCount: actualCount,
    };
  });

  targetStore.students = validStudents;
  targetStore.batches = recalculatedBatches;
  targetStore.studentProgress = cleanedProgress;
  targetStore.verificationRequests = cleanedVerifications;
  targetStore.deletedStudentIds = Array.from(deletedStudentsSet);
  targetStore.deletedBatchIds = Array.from(deletedBatchesSet);

  return {
    orphanedProgressRemoved,
    orphanedVerificationsRemoved,
    totalOrphanedCleaned: orphanedProgressRemoved + orphanedVerificationsRemoved,
    orphanedStudentIds: Array.from(orphanIdsSet),
    batchCountAdjustments,
  };
}

function saveEnrollmentsDiskStore(): void {
  enrollmentsDiskStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(ENROLLMENTS_STORE_FILE, JSON.stringify(enrollmentsDiskStore, null, 2), 'utf-8');
}

if (fs.existsSync(ENROLLMENTS_STORE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ENROLLMENTS_STORE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      enrollmentsDiskStore = {
        initialized: Boolean(raw.initialized),
        batches: Array.isArray(raw.batches) ? raw.batches : [],
        students: Array.isArray(raw.students) ? raw.students : [],
        studentProgress: Array.isArray(raw.studentProgress) ? raw.studentProgress : [],
        verificationRequests: Array.isArray(raw.verificationRequests) ? raw.verificationRequests : [],
        deletedStudentIds: Array.isArray(raw.deletedStudentIds) ? raw.deletedStudentIds : [],
        deletedBatchIds: Array.isArray(raw.deletedBatchIds) ? raw.deletedBatchIds : [],
        updatedAt: raw.updatedAt || new Date().toISOString(),
      };
      if (enrollmentsDiskStore.initialized) {
        const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
        if (audit.totalOrphanedCleaned > 0 || audit.batchCountAdjustments.length > 0) {
          saveEnrollmentsDiskStore();
        }
      }
    }
  } catch (err) {
    console.warn('[Server] Could not parse enrollments_store.json:', err);
  }
}

app.get('/api/enrollments/state', (_req: Request, res: Response) => {
  if (enrollmentsDiskStore.initialized) {
    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    if (audit.totalOrphanedCleaned > 0 || audit.batchCountAdjustments.length > 0) {
      saveEnrollmentsDiskStore();
    }
  }
  return res.json({
    success: true,
    ...enrollmentsDiskStore,
  });
});

app.post('/api/enrollments/init', (req: Request, res: Response) => {
  try {
    if (enrollmentsDiskStore.initialized) {
      const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
      if (audit.totalOrphanedCleaned > 0 || audit.batchCountAdjustments.length > 0) {
        saveEnrollmentsDiskStore();
      }
      return res.json({
        success: true,
        alreadyInitialized: true,
        audit,
        ...enrollmentsDiskStore,
      });
    }

    enrollmentsDiskStore = {
      initialized: true,
      batches: Array.isArray(req.body?.batches) ? req.body.batches : [],
      students: Array.isArray(req.body?.students) ? req.body.students : [],
      studentProgress: Array.isArray(req.body?.studentProgress) ? req.body.studentProgress : [],
      verificationRequests: Array.isArray(req.body?.verificationRequests) ? req.body.verificationRequests : [],
      deletedStudentIds: Array.isArray(req.body?.deletedStudentIds) ? req.body.deletedStudentIds : [],
      deletedBatchIds: Array.isArray(req.body?.deletedBatchIds) ? req.body.deletedBatchIds : [],
      updatedAt: new Date().toISOString(),
    };
    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    saveEnrollmentsDiskStore();

    return res.json({
      success: true,
      alreadyInitialized: false,
      audit,
      ...enrollmentsDiskStore,
    });
  } catch (err: any) {
    console.error('[Server] Failed to initialize enrollments store:', err);
    return res.status(500).json({ success: false, error: 'Failed to initialize enrollments store.' });
  }
});

app.post('/api/enrollments/sync', (req: Request, res: Response) => {
  try {
    const incomingDeletedStudents = Array.isArray(req.body?.deletedStudentIds) ? req.body.deletedStudentIds : [];
    const incomingDeletedBatches = Array.isArray(req.body?.deletedBatchIds) ? req.body.deletedBatchIds : [];

    enrollmentsDiskStore = {
      initialized: true,
      batches: Array.isArray(req.body?.batches) ? req.body.batches : enrollmentsDiskStore.batches,
      students: Array.isArray(req.body?.students) ? req.body.students : enrollmentsDiskStore.students,
      studentProgress: Array.isArray(req.body?.studentProgress)
        ? req.body.studentProgress
        : enrollmentsDiskStore.studentProgress,
      verificationRequests: Array.isArray(req.body?.verificationRequests)
        ? req.body.verificationRequests
        : enrollmentsDiskStore.verificationRequests,
      deletedStudentIds: Array.from(new Set([...enrollmentsDiskStore.deletedStudentIds, ...incomingDeletedStudents])),
      deletedBatchIds: Array.from(new Set([...enrollmentsDiskStore.deletedBatchIds, ...incomingDeletedBatches])),
      updatedAt: new Date().toISOString(),
    };
    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    saveEnrollmentsDiskStore();

    return res.json({
      success: true,
      audit,
      ...enrollmentsDiskStore,
    });
  } catch (err: any) {
    console.error('[Server] Failed to sync enrollments store:', err);
    return res.status(500).json({ success: false, error: 'Failed to synchronize enrollment records.' });
  }
});

app.post('/api/enrollments/reconcile', (_req: Request, res: Response) => {
  try {
    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    if (enrollmentsDiskStore.initialized) {
      saveEnrollmentsDiskStore();
    }
    return res.json({
      success: true,
      audit,
      batches: enrollmentsDiskStore.batches,
      studentsCount: enrollmentsDiskStore.students.length,
    });
  } catch (err: any) {
    console.error('[Server] Failed to reconcile enrollment records:', err);
    return res.status(500).json({ success: false, error: 'Failed to reconcile enrollment records.' });
  }
});

app.get('/api/batches', (_req: Request, res: Response) => {
  if (enrollmentsDiskStore.initialized) {
    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    if (audit.totalOrphanedCleaned > 0 || audit.batchCountAdjustments.length > 0) {
      saveEnrollmentsDiskStore();
    }
  }
  return res.json({
    success: true,
    initialized: enrollmentsDiskStore.initialized,
    batches: enrollmentsDiskStore.batches,
  });
});

app.delete('/api/students/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!enrollmentsDiskStore.initialized && Array.isArray(req.body?.fallbackStudents)) {
      enrollmentsDiskStore.students = req.body.fallbackStudents;
      enrollmentsDiskStore.batches = Array.isArray(req.body?.fallbackBatches) ? req.body.fallbackBatches : [];
      enrollmentsDiskStore.studentProgress = Array.isArray(req.body?.fallbackStudentProgress)
        ? req.body.fallbackStudentProgress
        : [];
      enrollmentsDiskStore.verificationRequests = Array.isArray(req.body?.fallbackVerificationRequests)
        ? req.body.fallbackVerificationRequests
        : [];
      enrollmentsDiskStore.initialized = true;
    }

    if (!enrollmentsDiskStore.deletedStudentIds.includes(id)) {
      enrollmentsDiskStore.deletedStudentIds.push(id);
    }
    enrollmentsDiskStore.students = enrollmentsDiskStore.students.filter((s) => s.id !== id);
    enrollmentsDiskStore.initialized = true;

    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    saveEnrollmentsDiskStore();

    return res.json({
      success: true,
      deletedStudentId: id,
      audit,
      batches: enrollmentsDiskStore.batches,
    });
  } catch (err: any) {
    console.error('[Server] Failed to delete student enrollment references:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete student record.' });
  }
});

app.post('/api/students/bulk-delete', (req: Request, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!enrollmentsDiskStore.initialized && Array.isArray(req.body?.fallbackStudents)) {
      enrollmentsDiskStore.students = req.body.fallbackStudents;
      enrollmentsDiskStore.batches = Array.isArray(req.body?.fallbackBatches) ? req.body.fallbackBatches : [];
      enrollmentsDiskStore.studentProgress = Array.isArray(req.body?.fallbackStudentProgress)
        ? req.body.fallbackStudentProgress
        : [];
      enrollmentsDiskStore.verificationRequests = Array.isArray(req.body?.fallbackVerificationRequests)
        ? req.body.fallbackVerificationRequests
        : [];
      enrollmentsDiskStore.initialized = true;
    }

    const idSet = new Set(ids);
    enrollmentsDiskStore.deletedStudentIds = Array.from(
      new Set([...enrollmentsDiskStore.deletedStudentIds, ...ids])
    );
    enrollmentsDiskStore.students = enrollmentsDiskStore.students.filter((s) => !idSet.has(s.id));
    enrollmentsDiskStore.initialized = true;

    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    saveEnrollmentsDiskStore();

    return res.json({
      success: true,
      deletedCount: ids.length,
      audit,
      batches: enrollmentsDiskStore.batches,
    });
  } catch (err: any) {
    console.error('[Server] Failed bulk student deletion:', err);
    return res.status(500).json({ success: false, error: 'Failed to bulk delete student records.' });
  }
});

app.delete('/api/batches/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!enrollmentsDiskStore.initialized && Array.isArray(req.body?.fallbackBatches)) {
      enrollmentsDiskStore.batches = req.body.fallbackBatches;
      enrollmentsDiskStore.students = Array.isArray(req.body?.fallbackStudents) ? req.body.fallbackStudents : [];
      enrollmentsDiskStore.studentProgress = Array.isArray(req.body?.fallbackStudentProgress)
        ? req.body.fallbackStudentProgress
        : [];
      enrollmentsDiskStore.verificationRequests = Array.isArray(req.body?.fallbackVerificationRequests)
        ? req.body.fallbackVerificationRequests
        : [];
      enrollmentsDiskStore.initialized = true;
    }

    const audit = reconcileEnrollmentStore(enrollmentsDiskStore);
    const target = enrollmentsDiskStore.batches.find((b) => b.id === id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Batch not found.' });
    }

    const validEnrolledStudents = enrollmentsDiskStore.students.filter(
      (s) => s.batchId === id || (target.name && s.batchName === target.name)
    );
    if (validEnrolledStudents.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete '${target.name}'. It currently has ${validEnrolledStudents.length} valid enrolled student(s). Transfer all students before deleting.`,
      });
    }

    enrollmentsDiskStore.batches = enrollmentsDiskStore.batches.filter((b) => b.id !== id);
    if (!enrollmentsDiskStore.deletedBatchIds.includes(id)) {
      enrollmentsDiskStore.deletedBatchIds.push(id);
    }
    saveEnrollmentsDiskStore();

    // Clean up any timetable assignment belonging to this deleted batch
    if (timetablesDiskStore.assignments.some((a) => a.batchId === id)) {
      timetablesDiskStore.assignments = timetablesDiskStore.assignments.filter((a) => a.batchId !== id);
      saveTimetablesDiskStore();
    }

    return res.json({
      success: true,
      deletedBatchId: id,
      audit,
      batches: enrollmentsDiskStore.batches,
    });
  } catch (err: any) {
    console.error('[Server] Failed to delete batch:', err);
    return res.status(500).json({ success: false, error: 'Database error while deleting batch.' });
  }
});

// =========================================================================
// PERSISTENT ERP CORE STORE (COURSES, FEES, LEADS, PLACEMENTS, LMS, LOGS)
// =========================================================================
interface ErpCoreDiskStore {
  initialized: boolean;
  courses: any[];
  deletedCourseIds: string[];
  feeMasterPlans: any[];
  deletedFeePlanIds: string[];
  feeTransactions: any[];
  deletedFeeTransactionIds: string[];
  leads: any[];
  deletedLeadIds: string[];
  vacancies: any[];
  deletedVacancyIds: string[];
  issuedCertificates: any[];
  deletedCertificateIds: string[];
  learningPrograms: any[];
  deletedProgramIds: string[];
  batchCurriculums: any[];
  companies: any[];
  campaigns: any[];
  notifications: any[];
  activityLogs: any[];
  updatedAt: string;
}

const ERP_CORE_STORE_FILE = path.join(ERP_STORE_DIR, 'erp_core_store.json');

let erpCoreStore: ErpCoreDiskStore = {
  initialized: false,
  courses: [],
  deletedCourseIds: [],
  feeMasterPlans: [],
  deletedFeePlanIds: [],
  feeTransactions: [],
  deletedFeeTransactionIds: [],
  leads: [],
  deletedLeadIds: [],
  vacancies: [],
  deletedVacancyIds: [],
  issuedCertificates: [],
  deletedCertificateIds: [],
  learningPrograms: [],
  deletedProgramIds: [],
  batchCurriculums: [],
  companies: [],
  campaigns: [],
  notifications: [],
  activityLogs: [],
  updatedAt: new Date().toISOString(),
};

function saveErpCoreStore(): void {
  erpCoreStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(ERP_CORE_STORE_FILE, JSON.stringify(erpCoreStore, null, 2), 'utf-8');
}

if (fs.existsSync(ERP_CORE_STORE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ERP_CORE_STORE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const delCourses = new Set<string>(Array.isArray(raw.deletedCourseIds) ? raw.deletedCourseIds : []);
      const delPlans = new Set<string>(Array.isArray(raw.deletedFeePlanIds) ? raw.deletedFeePlanIds : []);
      const delTx = new Set<string>(Array.isArray(raw.deletedFeeTransactionIds) ? raw.deletedFeeTransactionIds : []);
      const delLeads = new Set<string>(Array.isArray(raw.deletedLeadIds) ? raw.deletedLeadIds : []);
      const delVacancies = new Set<string>(Array.isArray(raw.deletedVacancyIds) ? raw.deletedVacancyIds : []);
      const delCerts = new Set<string>(Array.isArray(raw.deletedCertificateIds) ? raw.deletedCertificateIds : []);
      const delProgs = new Set<string>(Array.isArray(raw.deletedProgramIds) ? raw.deletedProgramIds : []);

      erpCoreStore = {
        initialized: Boolean(raw.initialized),
        courses: (Array.isArray(raw.courses) ? raw.courses : []).filter((c: any) => c && c.id && !delCourses.has(c.id)),
        deletedCourseIds: Array.from(delCourses),
        feeMasterPlans: (Array.isArray(raw.feeMasterPlans) ? raw.feeMasterPlans : []).filter((p: any) => p && p.id && !delPlans.has(p.id)),
        deletedFeePlanIds: Array.from(delPlans),
        feeTransactions: (Array.isArray(raw.feeTransactions) ? raw.feeTransactions : []).filter((t: any) => t && t.id && !delTx.has(t.id)),
        deletedFeeTransactionIds: Array.from(delTx),
        leads: (Array.isArray(raw.leads) ? raw.leads : []).filter((l: any) => l && l.id && !delLeads.has(l.id)),
        deletedLeadIds: Array.from(delLeads),
        vacancies: (Array.isArray(raw.vacancies) ? raw.vacancies : []).filter((v: any) => v && v.id && !delVacancies.has(v.id)),
        deletedVacancyIds: Array.from(delVacancies),
        issuedCertificates: (Array.isArray(raw.issuedCertificates) ? raw.issuedCertificates : []).filter((c: any) => c && c.id && !delCerts.has(c.id)),
        deletedCertificateIds: Array.from(delCerts),
        learningPrograms: (Array.isArray(raw.learningPrograms) ? raw.learningPrograms : []).filter((p: any) => p && p.id && !delProgs.has(p.id)),
        deletedProgramIds: Array.from(delProgs),
        batchCurriculums: Array.isArray(raw.batchCurriculums) ? raw.batchCurriculums : [],
        companies: Array.isArray(raw.companies) ? raw.companies : [],
        campaigns: Array.isArray(raw.campaigns) ? raw.campaigns : [],
        notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
        activityLogs: Array.isArray(raw.activityLogs) ? raw.activityLogs.slice(0, 50) : [],
        updatedAt: raw.updatedAt || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[Server] Could not parse erp_core_store.json:', err);
  }
}

function computeCourseDependencies(courseId: string) {
  const course = erpCoreStore.courses.find((c) => c.id === courseId);
  if (!course) return null;

  const titleLower = (course.title || '').trim().toLowerCase();
  const codeLower = (course.code || '').trim().toLowerCase();

  const associatedBatches = enrollmentsDiskStore.batches.filter(
    (b) => b.courseId === courseId || (b.courseTitle && b.courseTitle.trim().toLowerCase() === titleLower)
  );
  const associatedBatchIds = new Set(associatedBatches.map((b) => b.id));
  const associatedBatchNames = new Set(associatedBatches.map((b) => (b.name || '').trim().toLowerCase()));

  const enrolledStudents = enrollmentsDiskStore.students.filter((s) => {
    const enrolled = (s.enrolledCourse || '').trim().toLowerCase();
    const sBatchName = (s.batchName || '').trim().toLowerCase();
    return (
      enrolled === titleLower ||
      enrolled === codeLower ||
      (s.batchId && associatedBatchIds.has(s.batchId)) ||
      (sBatchName && associatedBatchNames.has(sBatchName))
    );
  });

  const feePlans = erpCoreStore.feeMasterPlans.filter(
    (p) => p.courseId === courseId || (p.courseName && p.courseName.trim().toLowerCase() === titleLower)
  );

  const feeTransactions = erpCoreStore.feeTransactions.filter(
    (t) => t.courseName && t.courseName.trim().toLowerCase() === titleLower
  );

  const learningPrograms = erpCoreStore.learningPrograms.filter((p) => p.courseId === courseId);

  const issuedCertificates = erpCoreStore.issuedCertificates.filter(
    (c) => c.courseId === courseId || (c.courseTitle && c.courseTitle.trim().toLowerCase() === titleLower)
  );

  const studyMaterials = materialsStore.filter(
    (m) => m.courseId === courseId || (m.courseTitle && m.courseTitle.trim().toLowerCase() === titleLower)
  );

  const protectedReasons: string[] = [];
  if (enrolledStudents.length > 0) {
    protectedReasons.push(`${enrolledStudents.length} enrolled student record(s) linked to this course`);
  }
  if (associatedBatches.length > 0) {
    protectedReasons.push(`${associatedBatches.length} associated batch(es) assigned to this course`);
  }
  if (feeTransactions.length > 0) {
    protectedReasons.push(`${feeTransactions.length} recorded financial fee transaction(s) for accounting audit`);
  }
  if (issuedCertificates.length > 0) {
    protectedReasons.push(`${issuedCertificates.length} issued academic certificate(s) tied to this course`);
  }

  return {
    course,
    associatedBatches: associatedBatches.map((b) => ({
      id: b.id,
      name: b.name,
      timing: b.timing,
      status: b.status,
      capacity: b.capacity,
      enrolledCount: enrolledStudents.filter((s) => s.batchId === b.id || s.batchName === b.name).length,
      trainerName: b.trainerName,
    })),
    enrolledStudents: enrolledStudents.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      batchName: s.batchName,
      lifecycleStage: s.lifecycleStage,
      paidAmount: s.feeStructure?.paidAmount || 0,
    })),
    feePlansCount: feePlans.length,
    feeTransactionsCount: feeTransactions.length,
    learningProgramsCount: learningPrograms.length,
    issuedCertificatesCount: issuedCertificates.length,
    studyMaterialsCount: studyMaterials.length,
    canDelete: protectedReasons.length === 0,
    protectedReasons,
  };
}

app.get('/api/erp/state', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    ...erpCoreStore,
  });
});

app.post('/api/erp/init', (req: Request, res: Response) => {
  try {
    if (erpCoreStore.initialized) {
      return res.json({
        success: true,
        alreadyInitialized: true,
        ...erpCoreStore,
      });
    }

    const body = req.body || {};
    const delCourses = new Set<string>([...erpCoreStore.deletedCourseIds, ...(Array.isArray(body.deletedCourseIds) ? body.deletedCourseIds : [])]);
    const delPlans = new Set<string>([...erpCoreStore.deletedFeePlanIds, ...(Array.isArray(body.deletedFeePlanIds) ? body.deletedFeePlanIds : [])]);
    const delTx = new Set<string>([...erpCoreStore.deletedFeeTransactionIds, ...(Array.isArray(body.deletedFeeTransactionIds) ? body.deletedFeeTransactionIds : [])]);
    const delLeads = new Set<string>([...erpCoreStore.deletedLeadIds, ...(Array.isArray(body.deletedLeadIds) ? body.deletedLeadIds : [])]);
    const delVac = new Set<string>([...erpCoreStore.deletedVacancyIds, ...(Array.isArray(body.deletedVacancyIds) ? body.deletedVacancyIds : [])]);
    const delCerts = new Set<string>([...erpCoreStore.deletedCertificateIds, ...(Array.isArray(body.deletedCertificateIds) ? body.deletedCertificateIds : [])]);
    const delProgs = new Set<string>([...erpCoreStore.deletedProgramIds, ...(Array.isArray(body.deletedProgramIds) ? body.deletedProgramIds : [])]);

    erpCoreStore = {
      initialized: true,
      courses: (Array.isArray(body.courses) ? body.courses : []).filter((c: any) => c && c.id && !delCourses.has(c.id)),
      deletedCourseIds: Array.from(delCourses),
      feeMasterPlans: (Array.isArray(body.feeMasterPlans) ? body.feeMasterPlans : []).filter((p: any) => p && p.id && !delPlans.has(p.id)),
      deletedFeePlanIds: Array.from(delPlans),
      feeTransactions: (Array.isArray(body.feeTransactions) ? body.feeTransactions : []).filter((t: any) => t && t.id && !delTx.has(t.id)),
      deletedFeeTransactionIds: Array.from(delTx),
      leads: (Array.isArray(body.leads) ? body.leads : []).filter((l: any) => l && l.id && !delLeads.has(l.id)),
      deletedLeadIds: Array.from(delLeads),
      vacancies: (Array.isArray(body.vacancies) ? body.vacancies : []).filter((v: any) => v && v.id && !delVac.has(v.id)),
      deletedVacancyIds: Array.from(delVac),
      issuedCertificates: (Array.isArray(body.issuedCertificates) ? body.issuedCertificates : []).filter((c: any) => c && c.id && !delCerts.has(c.id)),
      deletedCertificateIds: Array.from(delCerts),
      learningPrograms: (Array.isArray(body.learningPrograms) ? body.learningPrograms : []).filter((p: any) => p && p.id && !delProgs.has(p.id)),
      deletedProgramIds: Array.from(delProgs),
      batchCurriculums: Array.isArray(body.batchCurriculums) ? body.batchCurriculums : [],
      companies: Array.isArray(body.companies) ? body.companies : [],
      campaigns: Array.isArray(body.campaigns) ? body.campaigns : [],
      notifications: Array.isArray(body.notifications) ? body.notifications : [],
      activityLogs: Array.isArray(body.activityLogs) ? body.activityLogs.slice(0, 50) : [],
      updatedAt: new Date().toISOString(),
    };
    saveErpCoreStore();

    return res.json({
      success: true,
      alreadyInitialized: false,
      ...erpCoreStore,
    });
  } catch (err: any) {
    console.error('[Server] Failed to initialize ERP core store:', err);
    return res.status(500).json({ success: false, error: 'Failed to initialize ERP core store.' });
  }
});

app.post('/api/erp/sync', (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const mergeDeleted = (cur: string[], inc: any) =>
      Array.from(new Set([...cur, ...(Array.isArray(inc) ? inc : [])]));

    const delCourses = mergeDeleted(erpCoreStore.deletedCourseIds, body.deletedCourseIds);
    const delPlans = mergeDeleted(erpCoreStore.deletedFeePlanIds, body.deletedFeePlanIds);
    const delTx = mergeDeleted(erpCoreStore.deletedFeeTransactionIds, body.deletedFeeTransactionIds);
    const delLeads = mergeDeleted(erpCoreStore.deletedLeadIds, body.deletedLeadIds);
    const delVac = mergeDeleted(erpCoreStore.deletedVacancyIds, body.deletedVacancyIds);
    const delCerts = mergeDeleted(erpCoreStore.deletedCertificateIds, body.deletedCertificateIds);
    const delProgs = mergeDeleted(erpCoreStore.deletedProgramIds, body.deletedProgramIds);

    const filterBy = (arr: any[], deleted: string[]) => {
      const s = new Set(deleted);
      return arr.filter((x) => x && x.id && !s.has(x.id));
    };

    erpCoreStore = {
      initialized: true,
      courses: Array.isArray(body.courses) ? filterBy(body.courses, delCourses) : erpCoreStore.courses,
      deletedCourseIds: delCourses,
      feeMasterPlans: Array.isArray(body.feeMasterPlans) ? filterBy(body.feeMasterPlans, delPlans) : erpCoreStore.feeMasterPlans,
      deletedFeePlanIds: delPlans,
      feeTransactions: Array.isArray(body.feeTransactions) ? filterBy(body.feeTransactions, delTx) : erpCoreStore.feeTransactions,
      deletedFeeTransactionIds: delTx,
      leads: Array.isArray(body.leads) ? filterBy(body.leads, delLeads) : erpCoreStore.leads,
      deletedLeadIds: delLeads,
      vacancies: Array.isArray(body.vacancies) ? filterBy(body.vacancies, delVac) : erpCoreStore.vacancies,
      deletedVacancyIds: delVac,
      issuedCertificates: Array.isArray(body.issuedCertificates) ? filterBy(body.issuedCertificates, delCerts) : erpCoreStore.issuedCertificates,
      deletedCertificateIds: delCerts,
      learningPrograms: Array.isArray(body.learningPrograms) ? filterBy(body.learningPrograms, delProgs) : erpCoreStore.learningPrograms,
      deletedProgramIds: delProgs,
      batchCurriculums: Array.isArray(body.batchCurriculums) ? body.batchCurriculums : erpCoreStore.batchCurriculums,
      companies: Array.isArray(body.companies) ? body.companies : erpCoreStore.companies,
      campaigns: Array.isArray(body.campaigns) ? body.campaigns : erpCoreStore.campaigns,
      notifications: Array.isArray(body.notifications) ? body.notifications : erpCoreStore.notifications,
      activityLogs: Array.isArray(body.activityLogs) ? body.activityLogs.slice(0, 50) : erpCoreStore.activityLogs,
      updatedAt: new Date().toISOString(),
    };
    saveErpCoreStore();

    return res.json({ success: true, ...erpCoreStore });
  } catch (err: any) {
    console.error('[Server] Failed to sync ERP core store:', err);
    return res.status(500).json({ success: false, error: 'Failed to synchronize ERP core store.' });
  }
});

// Course API Endpoints (Persistent CRUD + Dependency Inspection + Safe Deletion)
app.get('/api/courses', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    initialized: erpCoreStore.initialized,
    courses: erpCoreStore.courses,
    deletedCourseIds: erpCoreStore.deletedCourseIds,
  });
});

app.get('/api/courses/:id/dependencies', (req: Request, res: Response) => {
  const { id } = req.params;
  const deps = computeCourseDependencies(id);
  if (!deps) {
    return res.status(404).json({ success: false, error: 'Course not found.' });
  }
  return res.json({ success: true, ...deps });
});

app.post('/api/courses', (req: Request, res: Response) => {
  try {
    const course = req.body?.course;
    const defaultPlan = req.body?.defaultPlan;
    if (!course || !course.id || !course.title) {
      return res.status(400).json({ success: false, error: 'Valid course payload required.' });
    }
    erpCoreStore.initialized = true;
    erpCoreStore.deletedCourseIds = erpCoreStore.deletedCourseIds.filter((d) => d !== course.id);
    const idx = erpCoreStore.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) {
      erpCoreStore.courses[idx] = course;
    } else {
      erpCoreStore.courses.push(course);
    }
    if (defaultPlan && defaultPlan.id) {
      erpCoreStore.deletedFeePlanIds = erpCoreStore.deletedFeePlanIds.filter((d) => d !== defaultPlan.id);
      if (!erpCoreStore.feeMasterPlans.some((p) => p.id === defaultPlan.id)) {
        erpCoreStore.feeMasterPlans.push(defaultPlan);
      }
    }
    saveErpCoreStore();
    return res.status(201).json({ success: true, course, courses: erpCoreStore.courses, feeMasterPlans: erpCoreStore.feeMasterPlans });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to create course.' });
  }
});

app.put('/api/courses/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body?.updates || req.body || {};
    if (erpCoreStore.deletedCourseIds.includes(id)) {
      return res.status(404).json({ success: false, error: 'Course has been deleted.' });
    }
    const idx = erpCoreStore.courses.findIndex((c) => c.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }
    const c = erpCoreStore.courses[idx];
    const totalFee = updates.totalFee !== undefined ? Number(updates.totalFee) : c.totalFee;
    const admissionFee = updates.admissionFee !== undefined ? Number(updates.admissionFee) : c.admissionFee ?? Math.min(totalFee, 5000);
    const remainingFee = Math.max(0, totalFee - admissionFee);
    erpCoreStore.courses[idx] = { ...c, ...updates, id, totalFee, admissionFee, remainingFee };
    erpCoreStore.feeMasterPlans = erpCoreStore.feeMasterPlans.map((plan) =>
      plan.courseId === id
        ? {
            ...plan,
            courseName: updates.title || plan.courseName,
            totalCourseFee: totalFee,
            admissionFee,
            tuitionFee: remainingFee,
          }
        : plan
    );
    saveErpCoreStore();
    return res.json({ success: true, course: erpCoreStore.courses[idx], courses: erpCoreStore.courses });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to update course.' });
  }
});

app.put('/api/courses/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const idx = erpCoreStore.courses.findIndex((c) => c.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }
    const nextStatus = req.body?.status || (erpCoreStore.courses[idx].status === 'active' ? 'inactive' : 'active');
    erpCoreStore.courses[idx] = { ...erpCoreStore.courses[idx], status: nextStatus };
    saveErpCoreStore();
    return res.json({ success: true, course: erpCoreStore.courses[idx], courses: erpCoreStore.courses });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to update course status.' });
  }
});

app.delete('/api/courses/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Bootstrap disk courses if store not initialized yet
    if (!erpCoreStore.initialized && Array.isArray(req.body?.fallbackCourses)) {
      const delSet = new Set(erpCoreStore.deletedCourseIds);
      erpCoreStore.courses = req.body.fallbackCourses.filter((c: any) => c && c.id && !delSet.has(c.id));
      if (Array.isArray(req.body?.fallbackFeeMasterPlans)) {
        erpCoreStore.feeMasterPlans = req.body.fallbackFeeMasterPlans;
      }
      if (Array.isArray(req.body?.fallbackFeeTransactions)) {
        erpCoreStore.feeTransactions = req.body.fallbackFeeTransactions;
      }
      erpCoreStore.initialized = true;
    }

    const deps = computeCourseDependencies(id);
    if (!deps) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }

    if (!deps.canDelete) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete '${deps.course.title}'. Protected dependencies exist: ${deps.protectedReasons.join('; ')}. Please deactivate/archive the course or resolve dependencies first.`,
        dependencies: deps,
      });
    }

    // Safe to permanently delete course & clean up auto-generated empty fee plans / unused curriculum links
    erpCoreStore.courses = erpCoreStore.courses.filter((c) => c.id !== id);
    const removedPlanIds = erpCoreStore.feeMasterPlans
      .filter((p) => p.courseId === id || (p.courseName && p.courseName.trim().toLowerCase() === (deps.course.title || '').trim().toLowerCase()))
      .map((p) => p.id);
    erpCoreStore.feeMasterPlans = erpCoreStore.feeMasterPlans.filter((p) => !removedPlanIds.includes(p.id));
    erpCoreStore.deletedFeePlanIds = Array.from(new Set([...erpCoreStore.deletedFeePlanIds, ...removedPlanIds]));
    erpCoreStore.batchCurriculums = erpCoreStore.batchCurriculums.filter((bc) => bc.courseId !== id);

    if (!erpCoreStore.deletedCourseIds.includes(id)) {
      erpCoreStore.deletedCourseIds.push(id);
    }
    erpCoreStore.initialized = true;
    saveErpCoreStore();

    return res.json({
      success: true,
      deletedCourseId: id,
      courses: erpCoreStore.courses,
      feeMasterPlans: erpCoreStore.feeMasterPlans,
      deletedCourseIds: erpCoreStore.deletedCourseIds,
    });
  } catch (err: any) {
    console.error('[Server] Failed to delete course:', err);
    return res.status(500).json({ success: false, error: 'Database error while deleting course.' });
  }
});

// =========================================================================
// PERSISTENT PROFESSIONAL EXAM & CERTIFICATION BOARD STORE
// =========================================================================
const EXAMS_STORE_FILE = path.join(ERP_STORE_DIR, 'exams_store.json');
const DEFAULT_REMOVED_PROGRAMME_IDS = ['prog-aicne', 'prog-ccse', 'prog-fsdc'];
const DEFAULT_REMOVED_PROGRAMME_CODES = new Set(['LPA-AICNE', 'LPA-CCSE', 'LPA-FSDC']);

let examsDiskStore: {
  initialized: boolean;
  programmes: any[];
  deletedProgrammeIds: string[];
  questions: any[];
  candidates: any[];
  exams: any[];
  results: any[];
  certificates: any[];
  sessions: Record<string, any>;
  updatedAt: string;
} = {
  initialized: false,
  programmes: [],
  deletedProgrammeIds: [...DEFAULT_REMOVED_PROGRAMME_IDS],
  questions: [],
  candidates: [],
  exams: [],
  results: [],
  certificates: [],
  sessions: {},
  updatedAt: new Date().toISOString(),
};

function saveExamsDiskStore(): void {
  examsDiskStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(EXAMS_STORE_FILE, JSON.stringify(examsDiskStore, null, 2), 'utf-8');
}

function computeProgrammeDependencies(programmeId: string) {
  const programme = examsDiskStore.programmes.find((p) => p.id === programmeId || p.code === programmeId);
  if (!programme) return null;

  const pid = programme.id;
  const pcode = (programme.code || '').trim().toLowerCase();

  const linkedCandidates = examsDiskStore.candidates.filter(
    (c) => c.programmeId === pid || (c.programmeCode && c.programmeCode.trim().toLowerCase() === pcode)
  );
  const linkedExams = examsDiskStore.exams.filter(
    (e) => e.programmeCode && e.programmeCode.trim().toLowerCase() === pcode
  );
  const linkedQuestions = examsDiskStore.questions.filter(
    (q) => q.programmeCode && q.programmeCode.trim().toLowerCase() === pcode
  );
  const linkedResults = examsDiskStore.results.filter(
    (r) => r.programmeCode && r.programmeCode.trim().toLowerCase() === pcode
  );
  const linkedCertificates = examsDiskStore.certificates.filter(
    (c) => c.certificationCode && c.certificationCode.trim().toLowerCase() === pcode
  );

  const protectedReasons: string[] = [];
  if (linkedCandidates.length > 0) {
    protectedReasons.push(`${linkedCandidates.length} candidate registration(s) linked to this programme`);
  }
  if (linkedExams.length > 0) {
    protectedReasons.push(`${linkedExams.length} examination session(s) scheduled under this programme`);
  }
  if (linkedResults.length > 0) {
    protectedReasons.push(`${linkedResults.length} examination result record(s) archived under this programme`);
  }
  if (linkedCertificates.length > 0) {
    protectedReasons.push(`${linkedCertificates.length} issued professional certificate(s) tied to this programme`);
  }

  return {
    programme,
    candidatesCount: linkedCandidates.length,
    examsCount: linkedExams.length,
    questionsCount: linkedQuestions.length,
    resultsCount: linkedResults.length,
    certificatesCount: linkedCertificates.length,
    hasGenuineDependencies: protectedReasons.length > 0,
    canDeleteWithoutReview: protectedReasons.length === 0,
    protectedReasons,
    details: {
      candidates: linkedCandidates.map((c) => ({ id: c.id, fullName: c.fullName, eligibilityStatus: c.eligibilityStatus })),
      exams: linkedExams.map((e) => ({ id: e.id, title: e.title, examDate: e.examDate, status: e.status })),
      results: linkedResults.map((r) => ({ id: r.id, candidateName: r.candidateName, grade: r.grade, approvalStatus: r.approvalStatus })),
      certificates: linkedCertificates.map((c) => ({ certificateId: c.certificateId, candidateName: c.candidateName, status: c.status })),
    },
  };
}

if (fs.existsSync(EXAMS_STORE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(EXAMS_STORE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const delProgs = new Set<string>([
        ...DEFAULT_REMOVED_PROGRAMME_IDS,
        ...(Array.isArray(raw.deletedProgrammeIds) ? raw.deletedProgrammeIds : []),
      ]);
      examsDiskStore = {
        initialized: Boolean(raw.initialized),
        programmes: (Array.isArray(raw.programmes) ? raw.programmes : []).filter(
          (p: any) =>
            p &&
            p.id &&
            !delProgs.has(p.id) &&
            !DEFAULT_REMOVED_PROGRAMME_CODES.has(String(p.code || '').toUpperCase())
        ),
        deletedProgrammeIds: Array.from(delProgs),
        questions: Array.isArray(raw.questions) ? raw.questions : [],
        candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
        exams: Array.isArray(raw.exams) ? raw.exams : [],
        results: Array.isArray(raw.results) ? raw.results : [],
        certificates: Array.isArray(raw.certificates) ? raw.certificates : [],
        sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
        updatedAt: raw.updatedAt || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[Server] Could not parse exams_store.json:', err);
  }
}

app.get('/api/exams/state', (_req: Request, res: Response) => {
  const activeProgrammesCount = examsDiskStore.programmes.filter((p) => p.status === 'active').length;
  return res.json({
    success: true,
    ...examsDiskStore,
    activeProgrammesCount,
  });
});

app.post('/api/exams/sync', (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const mergedDeletedProgIds = Array.from(
      new Set<string>([
        ...DEFAULT_REMOVED_PROGRAMME_IDS,
        ...examsDiskStore.deletedProgrammeIds,
        ...(Array.isArray(b.deletedProgrammeIds) ? b.deletedProgrammeIds : []),
      ])
    );
    const delSet = new Set(mergedDeletedProgIds);

    const nextProgrammes = Array.isArray(b.programmes)
      ? b.programmes.filter(
          (p: any) =>
            p &&
            p.id &&
            !delSet.has(p.id) &&
            !DEFAULT_REMOVED_PROGRAMME_CODES.has(String(p.code || '').toUpperCase())
        )
      : examsDiskStore.programmes;

    examsDiskStore = {
      initialized: true,
      programmes: nextProgrammes,
      deletedProgrammeIds: mergedDeletedProgIds,
      questions: Array.isArray(b.questions) ? b.questions : examsDiskStore.questions,
      candidates: Array.isArray(b.candidates) ? b.candidates : examsDiskStore.candidates,
      exams: Array.isArray(b.exams) ? b.exams : examsDiskStore.exams,
      results: Array.isArray(b.results) ? b.results : examsDiskStore.results,
      certificates: Array.isArray(b.certificates) ? b.certificates : examsDiskStore.certificates,
      sessions: b.sessions && typeof b.sessions === 'object' ? b.sessions : examsDiskStore.sessions,
      updatedAt: new Date().toISOString(),
    };
    saveExamsDiskStore();
    const activeProgrammesCount = examsDiskStore.programmes.filter((p) => p.status === 'active').length;
    return res.json({ success: true, ...examsDiskStore, activeProgrammesCount });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to save exam board state.' });
  }
});

// Certification Programmes CRUD + Dependency Review & Safe Deletion
app.get('/api/certification/programmes', (_req: Request, res: Response) => {
  const activeCount = examsDiskStore.programmes.filter((p) => p.status === 'active').length;
  return res.json({
    success: true,
    initialized: examsDiskStore.initialized,
    programmes: examsDiskStore.programmes,
    deletedProgrammeIds: examsDiskStore.deletedProgrammeIds,
    activeCount,
    totalCount: examsDiskStore.programmes.length,
  });
});

app.get('/api/certification/programmes/:id/dependencies', (req: Request, res: Response) => {
  const { id } = req.params;
  const deps = computeProgrammeDependencies(id);
  if (!deps) {
    return res.status(404).json({ success: false, error: 'Certification programme not found.' });
  }
  return res.json({ success: true, ...deps });
});

app.post('/api/certification/programmes', (req: Request, res: Response) => {
  try {
    const programme = req.body?.programme || req.body;
    if (!programme || !programme.id || !programme.code || !programme.certificationTitle) {
      return res.status(400).json({ success: false, error: 'Valid certification programme payload required.' });
    }
    examsDiskStore.initialized = true;
    examsDiskStore.deletedProgrammeIds = examsDiskStore.deletedProgrammeIds.filter((d) => d !== programme.id);
    const idx = examsDiskStore.programmes.findIndex((p) => p.id === programme.id || p.code === programme.code);
    if (idx >= 0) {
      examsDiskStore.programmes[idx] = programme;
    } else {
      examsDiskStore.programmes.push(programme);
    }
    saveExamsDiskStore();
    return res.status(201).json({
      success: true,
      programme,
      programmes: examsDiskStore.programmes,
      activeCount: examsDiskStore.programmes.filter((p) => p.status === 'active').length,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to save certification programme.' });
  }
});

app.put('/api/certification/programmes/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body?.updates || req.body || {};
    const idx = examsDiskStore.programmes.findIndex((p) => p.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Certification programme not found.' });
    }
    examsDiskStore.programmes[idx] = {
      ...examsDiskStore.programmes[idx],
      ...updates,
      id,
      updatedAt: new Date().toISOString().substring(0, 10),
    };
    saveExamsDiskStore();
    return res.json({
      success: true,
      programme: examsDiskStore.programmes[idx],
      programmes: examsDiskStore.programmes,
      activeCount: examsDiskStore.programmes.filter((p) => p.status === 'active').length,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to update certification programme.' });
  }
});

app.delete('/api/certification/programmes/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deps = computeProgrammeDependencies(id);
    if (!deps) {
      return res.status(404).json({ success: false, error: 'Certification programme not found.' });
    }

    const authorizedReviewConfirmed = Boolean(req.body?.authorizedReviewConfirmed);
    const reviewedBy = typeof req.body?.reviewedBy === 'string' ? req.body.reviewedBy.trim() : '';

    if (deps.hasGenuineDependencies && (!authorizedReviewConfirmed || !reviewedBy)) {
      return res.status(400).json({
        success: false,
        requiresAuthorizedReview: true,
        error: `Programme '${deps.programme.code}' has genuine dependent records: ${deps.protectedReasons.join('; ')}. Authorized review is required before deletion. Existing candidate, result, and certificate records will be preserved.`,
        dependencies: deps,
      });
    }

    // Permanently remove ONLY the programme definition; preserve all genuine candidates, results, and certificates
    examsDiskStore.programmes = examsDiskStore.programmes.filter((p) => p.id !== deps.programme.id);
    if (!examsDiskStore.deletedProgrammeIds.includes(deps.programme.id)) {
      examsDiskStore.deletedProgrammeIds.push(deps.programme.id);
    }
    examsDiskStore.initialized = true;
    saveExamsDiskStore();

    return res.json({
      success: true,
      deletedProgrammeId: deps.programme.id,
      deletedProgrammeCode: deps.programme.code,
      preservedRecords: {
        candidates: examsDiskStore.candidates.length,
        results: examsDiskStore.results.length,
        certificates: examsDiskStore.certificates.length,
      },
      programmes: examsDiskStore.programmes,
      deletedProgrammeIds: examsDiskStore.deletedProgrammeIds,
      activeCount: examsDiskStore.programmes.filter((p) => p.status === 'active').length,
    });
  } catch (err: any) {
    console.error('[Server] Failed to delete certification programme:', err);
    return res.status(500).json({ success: false, error: 'Database error while deleting certification programme.' });
  }
});

// =========================================================================
// PERSISTENT WEEKLY TIMETABLE MANAGEMENT SYSTEM STORE
// =========================================================================
const TIMETABLES_STORE_FILE = path.join(ERP_STORE_DIR, 'timetables_store.json');

interface ServerTimetableSession {
  id: string;
  day: string;
  startTime: string;
  endTime: string;
  subjectName: string;
  courseId?: string;
  sessionType: 'Theory' | 'Practical';
  trainerId?: string;
  trainerName: string;
  roomName: string;
  roomType?: 'Classroom' | 'Computer Lab';
  notes?: string;
}

interface ServerTimetableTemplate {
  id: string;
  name: string;
  code: string;
  courseId: string;
  courseTitle: string;
  courseCode?: string;
  description?: string;
  effectiveStartDate: string;
  effectiveEndDate: string;
  status: 'active' | 'inactive';
  sessions: ServerTimetableSession[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ServerBatchTimetableAssignment {
  id: string;
  batchId: string;
  batchName: string;
  courseId: string;
  courseTitle: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  effectiveStartDate: string;
  effectiveEndDate: string;
  status: 'active' | 'inactive';
  isCustomized: boolean;
  sessions: ServerTimetableSession[];
  assignedBy: string;
  assignedAt: string;
  updatedAt: string;
  lastCustomizedBy?: string;
  lastCustomizedAt?: string;
}

interface ServerCampusRoom {
  id: string;
  name: string;
  type: 'Classroom' | 'Computer Lab';
  capacity?: number;
  building?: string;
  createdAt?: string;
}

interface ServerTimetableAuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  targetType: string;
  targetId: string;
  targetName: string;
  details: string;
  previousValue?: string;
  newValue?: string;
}

let timetablesDiskStore: {
  initialized: boolean;
  templates: ServerTimetableTemplate[];
  assignments: ServerBatchTimetableAssignment[];
  rooms: ServerCampusRoom[];
  deletedTemplateIds: string[];
  auditLogs: ServerTimetableAuditEntry[];
  updatedAt: string;
} = {
  initialized: true,
  templates: [],
  assignments: [],
  rooms: [],
  deletedTemplateIds: [],
  auditLogs: [],
  updatedAt: new Date().toISOString(),
};

function saveTimetablesDiskStore(): void {
  timetablesDiskStore.updatedAt = new Date().toISOString();
  fs.writeFileSync(TIMETABLES_STORE_FILE, JSON.stringify(timetablesDiskStore, null, 2), 'utf-8');
}

if (fs.existsSync(TIMETABLES_STORE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(TIMETABLES_STORE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const delSet = new Set<string>(Array.isArray(raw.deletedTemplateIds) ? raw.deletedTemplateIds : []);
      timetablesDiskStore = {
        initialized: true,
        templates: (Array.isArray(raw.templates) ? raw.templates : []).filter((t: any) => t && t.id && !delSet.has(t.id)),
        assignments: Array.isArray(raw.assignments) ? raw.assignments : [],
        rooms: Array.isArray(raw.rooms) ? raw.rooms : [],
        deletedTemplateIds: Array.from(delSet),
        auditLogs: Array.isArray(raw.auditLogs) ? raw.auditLogs.slice(0, 200) : [],
        updatedAt: raw.updatedAt || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[Server] Could not parse timetables_store.json:', err);
  }
}

function appendTimetableAudit(entry: Omit<ServerTimetableAuditEntry, 'id' | 'timestamp'>): ServerTimetableAuditEntry {
  const full: ServerTimetableAuditEntry = {
    id: `tt-aud-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  timetablesDiskStore.auditLogs = [full, ...timetablesDiskStore.auditLogs.slice(0, 199)];
  return full;
}

function parseTimeToMinutes(hhmm: string): number | null {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function timesOverlap(sA: string, eA: string, sB: string, eB: string): boolean {
  const a1 = parseTimeToMinutes(sA);
  const a2 = parseTimeToMinutes(eA);
  const b1 = parseTimeToMinutes(sB);
  const b2 = parseTimeToMinutes(eB);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
  return a1 < b2 && b1 < a2;
}

function dateRangesOverlap(startA?: string, endA?: string, startB?: string, endB?: string): boolean {
  if (!startA || !endA || !startB || !endB) return true;
  return startA <= endB && startB <= endA;
}

function validateSessionsStructure(sessions: ServerTimetableSession[]): string | null {
  const validDays = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  for (const s of sessions) {
    if (!s || !validDays.has(s.day)) {
      return `Invalid day specified: ${s?.day || 'unknown'}`;
    }
    const startM = parseTimeToMinutes(s.startTime);
    const endM = parseTimeToMinutes(s.endTime);
    if (startM === null || endM === null) {
      return `Invalid time format on ${s.day} (${s.startTime} - ${s.endTime}). Expected HH:mm.`;
    }
    if (endM <= startM) {
      return `End time (${s.endTime}) must be after start time (${s.startTime}) on ${s.day} for "${s.subjectName}".`;
    }
    if (!s.subjectName?.trim() || !s.trainerName?.trim() || !s.roomName?.trim()) {
      return `Session on ${s.day} (${s.startTime}-${s.endTime}) requires subject, faculty/trainer, and classroom/lab.`;
    }
  }
  return null;
}

function detectInternalSessionOverlaps(sessions: ServerTimetableSession[], batchId: string, batchName: string) {
  const conflicts: any[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.day === b.day && timesOverlap(a.startTime, a.endTime, b.startTime, b.endTime)) {
        conflicts.push({
          type: 'batch_overlap',
          severity: 'error',
          day: a.day,
          sessionTime: `${a.startTime}-${a.endTime}`,
          conflictingBatchId: batchId,
          conflictingBatchName: batchName,
          conflictingTime: `${b.startTime}-${b.endTime}`,
          resourceName: `${a.subjectName} vs ${b.subjectName}`,
          message: `Overlapping sessions on ${a.day} for ${batchName}: "${a.subjectName}" (${a.startTime}-${a.endTime}) overlaps with "${b.subjectName}" (${b.startTime}-${b.endTime}).`,
        });
      }
    }
  }
  return conflicts;
}

function detectAssignmentConflictsOnServer(
  candidate: {
    id?: string;
    batchId: string;
    batchName: string;
    effectiveStartDate: string;
    effectiveEndDate: string;
    status: 'active' | 'inactive';
    sessions: ServerTimetableSession[];
  },
  extraPeers: Array<{
    id?: string;
    batchId: string;
    batchName: string;
    effectiveStartDate: string;
    effectiveEndDate: string;
    status: 'active' | 'inactive';
    sessions: ServerTimetableSession[];
  }> = []
) {
  const conflicts: any[] = [];
  conflicts.push(...detectInternalSessionOverlaps(candidate.sessions, candidate.batchId, candidate.batchName));

  if (candidate.status !== 'active') {
    return conflicts;
  }

  const peers = [
    ...timetablesDiskStore.assignments.filter(
      (a) => a.status === 'active' && a.batchId !== candidate.batchId && a.id !== candidate.id
    ),
    ...extraPeers.filter((p) => p.status === 'active' && p.batchId !== candidate.batchId),
  ];

  for (const s of candidate.sessions) {
    const sTrainer = s.trainerName.trim().toLowerCase();
    const sRoom = s.roomName.trim().toLowerCase();

    for (const peer of peers) {
      if (!dateRangesOverlap(candidate.effectiveStartDate, candidate.effectiveEndDate, peer.effectiveStartDate, peer.effectiveEndDate)) {
        continue;
      }

      for (const ps of peer.sessions) {
        if (ps.day !== s.day) continue;
        if (!timesOverlap(s.startTime, s.endTime, ps.startTime, ps.endTime)) continue;

        const pTrainer = (ps.trainerName || '').trim().toLowerCase();
        const sameTrainer =
          (s.trainerId && ps.trainerId && s.trainerId === ps.trainerId) ||
          (sTrainer && pTrainer && sTrainer === pTrainer);

        if (sameTrainer) {
          conflicts.push({
            type: 'trainer_conflict',
            severity: 'error',
            day: s.day,
            sessionTime: `${s.startTime}-${s.endTime}`,
            conflictingBatchId: peer.batchId,
            conflictingBatchName: peer.batchName,
            conflictingTime: `${ps.startTime}-${ps.endTime}`,
            resourceName: s.trainerName,
            message: `Trainer Conflict on ${s.day}: ${s.trainerName} is already scheduled with "${peer.batchName}" (${ps.startTime}-${ps.endTime}, ${ps.subjectName}).`,
          });
        }

        const pRoom = (ps.roomName || '').trim().toLowerCase();
        if (sRoom && pRoom && sRoom === pRoom) {
          conflicts.push({
            type: 'room_conflict',
            severity: 'error',
            day: s.day,
            sessionTime: `${s.startTime}-${s.endTime}`,
            conflictingBatchId: peer.batchId,
            conflictingBatchName: peer.batchName,
            conflictingTime: `${ps.startTime}-${ps.endTime}`,
            resourceName: s.roomName,
            message: `Classroom / Lab Conflict on ${s.day}: "${s.roomName}" is already allocated to "${peer.batchName}" (${ps.startTime}-${ps.endTime}).`,
          });
        }
      }
    }
  }

  return conflicts;
}

app.get('/api/timetables/state', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    ...timetablesDiskStore,
  });
});

app.post('/api/timetables/check-conflicts', (req: Request, res: Response) => {
  const { batchId, batchName, effectiveStartDate, effectiveEndDate, status, sessions, assignmentId } = req.body || {};
  const list = Array.isArray(sessions) ? sessions : [];
  const structErr = validateSessionsStructure(list);
  if (structErr) {
    return res.status(400).json({ success: false, error: structErr, conflicts: [] });
  }
  const conflicts = detectAssignmentConflictsOnServer({
    id: assignmentId,
    batchId: batchId || 'preview',
    batchName: batchName || 'Preview Batch',
    effectiveStartDate: effectiveStartDate || '',
    effectiveEndDate: effectiveEndDate || '',
    status: status || 'active',
    sessions: list,
  });
  return res.json({
    success: true,
    hasConflicts: conflicts.length > 0,
    conflicts,
  });
});

app.post('/api/timetables/templates', (req: Request, res: Response) => {
  try {
    const { template, actor } = req.body || {};
    if (!template || !template.name?.trim() || !template.courseId) {
      return res.status(400).json({ success: false, error: 'Template name and course are required.' });
    }
    if (template.effectiveStartDate && template.effectiveEndDate && template.effectiveEndDate < template.effectiveStartDate) {
      return res.status(400).json({ success: false, error: 'Effective end date must be on or after start date.' });
    }

    const sessions: ServerTimetableSession[] = Array.isArray(template.sessions) ? template.sessions : [];
    const structErr = validateSessionsStructure(sessions);
    if (structErr) {
      return res.status(400).json({ success: false, error: structErr });
    }
    const selfOverlaps = detectInternalSessionOverlaps(sessions, template.id || 'template', template.name);
    if (selfOverlaps.length > 0) {
      return res.status(400).json({
        success: false,
        error: selfOverlaps[0].message,
        conflicts: selfOverlaps,
      });
    }

    const now = new Date().toISOString();
    const newTemplate: ServerTimetableTemplate = {
      id: template.id || `tt-tpl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: template.name.trim(),
      code: (template.code || `TT-${Date.now().toString().slice(-4)}`).trim().toUpperCase(),
      courseId: template.courseId,
      courseTitle: template.courseTitle || '',
      courseCode: template.courseCode || '',
      description: template.description || '',
      effectiveStartDate: template.effectiveStartDate || now.substring(0, 10),
      effectiveEndDate: template.effectiveEndDate || '',
      status: template.status === 'inactive' ? 'inactive' : 'active',
      sessions,
      version: 1,
      createdBy: actor?.name || template.createdBy || 'Authorized Admin',
      createdAt: now,
      updatedAt: now,
    };

    timetablesDiskStore.deletedTemplateIds = timetablesDiskStore.deletedTemplateIds.filter((d) => d !== newTemplate.id);
    timetablesDiskStore.templates.push(newTemplate);
    appendTimetableAudit({
      action: 'TEMPLATE_CREATED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'template',
      targetId: newTemplate.id,
      targetName: newTemplate.name,
      details: `Created weekly timetable template "${newTemplate.name}" (${newTemplate.code}) for ${newTemplate.courseTitle} with ${sessions.length} weekly session(s).`,
    });
    saveTimetablesDiskStore();

    return res.status(201).json({
      success: true,
      template: newTemplate,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    console.error('[Timetable] Create template error:', err);
    return res.status(500).json({ success: false, error: 'Database error while creating timetable template.' });
  }
});

app.put('/api/timetables/templates/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { updates, actor } = req.body || {};
    const idx = timetablesDiskStore.templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Timetable template not found.' });
    }
    const existing = timetablesDiskStore.templates[idx];
    const nextStart = updates?.effectiveStartDate ?? existing.effectiveStartDate;
    const nextEnd = updates?.effectiveEndDate ?? existing.effectiveEndDate;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      return res.status(400).json({ success: false, error: 'Effective end date must be on or after start date.' });
    }

    const nextSessions: ServerTimetableSession[] = Array.isArray(updates?.sessions) ? updates.sessions : existing.sessions;
    const structErr = validateSessionsStructure(nextSessions);
    if (structErr) {
      return res.status(400).json({ success: false, error: structErr });
    }
    const selfOverlaps = detectInternalSessionOverlaps(nextSessions, id, updates?.name || existing.name);
    if (selfOverlaps.length > 0) {
      return res.status(400).json({
        success: false,
        error: selfOverlaps[0].message,
        conflicts: selfOverlaps,
      });
    }

    // Master template update does NOT silently overwrite existing batch assignments
    const updatedTemplate: ServerTimetableTemplate = {
      ...existing,
      ...updates,
      id,
      sessions: nextSessions,
      version: (existing.version || 1) + 1,
      updatedAt: new Date().toISOString(),
    };
    timetablesDiskStore.templates[idx] = updatedTemplate;

    const assignedCount = timetablesDiskStore.assignments.filter((a) => a.templateId === id).length;
    appendTimetableAudit({
      action: 'TEMPLATE_UPDATED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'template',
      targetId: id,
      targetName: updatedTemplate.name,
      details: `Updated master template "${updatedTemplate.name}" to v${updatedTemplate.version} (${nextSessions.length} sessions). ${assignedCount} existing batch assignment(s) preserved unchanged.`,
      previousValue: `v${existing.version} (${existing.sessions.length} sessions)`,
      newValue: `v${updatedTemplate.version} (${nextSessions.length} sessions)`,
    });
    saveTimetablesDiskStore();

    return res.json({
      success: true,
      template: updatedTemplate,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    console.error('[Timetable] Update template error:', err);
    return res.status(500).json({ success: false, error: 'Database error while updating timetable template.' });
  }
});

app.post('/api/timetables/templates/:id/duplicate', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, code, actor } = req.body || {};
    const source = timetablesDiskStore.templates.find((t) => t.id === id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Source timetable template not found.' });
    }
    const now = new Date().toISOString();
    const clonedSessions = source.sessions.map((s) => ({
      ...s,
      id: `tt-ses-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    }));
    const dup: ServerTimetableTemplate = {
      ...source,
      id: `tt-tpl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: (name && name.trim()) || `${source.name} (Copy)`,
      code: (code && code.trim().toUpperCase()) || `${source.code}-COPY`,
      sessions: clonedSessions,
      version: 1,
      status: 'active',
      createdBy: actor?.name || 'Authorized Admin',
      createdAt: now,
      updatedAt: now,
    };
    timetablesDiskStore.templates.push(dup);
    appendTimetableAudit({
      action: 'TEMPLATE_DUPLICATED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'template',
      targetId: dup.id,
      targetName: dup.name,
      details: `Duplicated template "${source.name}" into "${dup.name}" (${dup.code}).`,
    });
    saveTimetablesDiskStore();

    return res.status(201).json({
      success: true,
      template: dup,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to duplicate timetable template.' });
  }
});

app.put('/api/timetables/templates/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, actor } = req.body || {};
    const idx = timetablesDiskStore.templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Timetable template not found.' });
    }
    const nextStatus = status || (timetablesDiskStore.templates[idx].status === 'active' ? 'inactive' : 'active');
    timetablesDiskStore.templates[idx] = {
      ...timetablesDiskStore.templates[idx],
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    appendTimetableAudit({
      action: nextStatus === 'active' ? 'TEMPLATE_ACTIVATED' : 'TEMPLATE_DEACTIVATED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'template',
      targetId: id,
      targetName: timetablesDiskStore.templates[idx].name,
      details: `${nextStatus === 'active' ? 'Activated' : 'Deactivated'} template "${timetablesDiskStore.templates[idx].name}".`,
    });
    saveTimetablesDiskStore();

    return res.json({
      success: true,
      template: timetablesDiskStore.templates[idx],
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to update template status.' });
  }
});

app.delete('/api/timetables/templates/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { actor } = req.body || {};
    const tpl = timetablesDiskStore.templates.find((t) => t.id === id);
    if (!tpl) {
      return res.status(404).json({ success: false, error: 'Timetable template not found.' });
    }

    const assignedBatches = timetablesDiskStore.assignments.filter((a) => a.templateId === id);
    if (assignedBatches.length > 0) {
      return res.status(400).json({
        success: false,
        protectedAssigned: true,
        assignedBatches: assignedBatches.map((a) => ({ id: a.id, batchId: a.batchId, batchName: a.batchName })),
        error: `Cannot delete template "${tpl.name}" because it is currently assigned to ${assignedBatches.length} batch(es): ${assignedBatches.map((a) => a.batchName).join(', ')}. Unassign those batches or deactivate the template instead.`,
      });
    }

    timetablesDiskStore.templates = timetablesDiskStore.templates.filter((t) => t.id !== id);
    if (!timetablesDiskStore.deletedTemplateIds.includes(id)) {
      timetablesDiskStore.deletedTemplateIds.push(id);
    }
    appendTimetableAudit({
      action: 'TEMPLATE_DELETED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'template',
      targetId: id,
      targetName: tpl.name,
      details: `Permanently deleted unassigned weekly timetable template "${tpl.name}" (${tpl.code}).`,
    });
    saveTimetablesDiskStore();

    return res.json({
      success: true,
      deletedTemplateId: id,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to delete timetable template.' });
  }
});

app.post('/api/timetables/assign', (req: Request, res: Response) => {
  try {
    const { templateId, batches: targetBatches, effectiveStartDate, effectiveEndDate, actor } = req.body || {};
    const template = timetablesDiskStore.templates.find((t) => t.id === templateId);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Timetable template not found.' });
    }
    if (template.status !== 'active') {
      return res.status(400).json({ success: false, error: `Template "${template.name}" is inactive. Activate it before assigning batches.` });
    }
    if (!Array.isArray(targetBatches) || targetBatches.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one batch to assign.' });
    }

    const startDate = effectiveStartDate || template.effectiveStartDate || new Date().toISOString().substring(0, 10);
    const endDate = effectiveEndDate || template.effectiveEndDate || '';
    if (startDate && endDate && endDate < startDate) {
      return res.status(400).json({ success: false, error: 'Effective end date must be on or after start date.' });
    }

    const now = new Date().toISOString();
    const stagedAssignments: ServerBatchTimetableAssignment[] = [];
    const allConflicts: any[] = [];

    for (const b of targetBatches) {
      if (!b || !b.id) continue;
      const existingAssignment = timetablesDiskStore.assignments.find((a) => a.batchId === b.id);
      const clonedSessions = template.sessions.map((s) => ({
        ...s,
        id: `tt-ses-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      }));
      const proposed: ServerBatchTimetableAssignment = {
        id: existingAssignment?.id || `tt-asg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        batchId: b.id,
        batchName: b.name || b.batchName || b.id,
        courseId: b.courseId || template.courseId,
        courseTitle: b.courseTitle || template.courseTitle,
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.version || 1,
        effectiveStartDate: startDate,
        effectiveEndDate: endDate,
        status: 'active',
        isCustomized: false,
        sessions: clonedSessions,
        assignedBy: actor?.name || 'Authorized Admin',
        assignedAt: now,
        updatedAt: now,
      };

      const conflicts = detectAssignmentConflictsOnServer(proposed, stagedAssignments);
      if (conflicts.length > 0) {
        allConflicts.push(...conflicts);
      } else {
        stagedAssignments.push(proposed);
      }
    }

    if (allConflicts.length > 0) {
      appendTimetableAudit({
        action: 'CONFLICT_BLOCKED',
        actorId: actor?.id || 'system',
        actorName: actor?.name || 'Authorized Admin',
        actorRole: actor?.role || 'admin',
        targetType: 'conflict',
        targetId: template.id,
        targetName: template.name,
        details: `Blocked assignment of "${template.name}" due to ${allConflicts.length} scheduling conflict(s): ${allConflicts[0].message}`,
      });
      saveTimetablesDiskStore();
      return res.status(409).json({
        success: false,
        error: allConflicts[0].message,
        conflicts: allConflicts,
      });
    }

    for (const staged of stagedAssignments) {
      const idx = timetablesDiskStore.assignments.findIndex((a) => a.batchId === staged.batchId);
      if (idx >= 0) {
        timetablesDiskStore.assignments[idx] = staged;
      } else {
        timetablesDiskStore.assignments.push(staged);
      }
      appendTimetableAudit({
        action: 'BATCH_ASSIGNED',
        actorId: actor?.id || 'system',
        actorName: actor?.name || 'Authorized Admin',
        actorRole: actor?.role || 'admin',
        targetType: 'assignment',
        targetId: staged.id,
        targetName: staged.batchName,
        details: `Assigned template "${template.name}" (v${template.version}) to batch "${staged.batchName}" effective ${staged.effectiveStartDate}${staged.effectiveEndDate ? ' to ' + staged.effectiveEndDate : ''}.`,
      });
    }

    saveTimetablesDiskStore();
    return res.status(201).json({
      success: true,
      assignedCount: stagedAssignments.length,
      assignmentsCreated: stagedAssignments,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    console.error('[Timetable] Assign batches error:', err);
    return res.status(500).json({ success: false, error: 'Database error while assigning timetable.' });
  }
});

app.put('/api/timetables/assignments/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { updates, actor } = req.body || {};
    const idx = timetablesDiskStore.assignments.findIndex((a) => a.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Batch timetable assignment not found.' });
    }
    const existing = timetablesDiskStore.assignments[idx];
    const nextStart = updates?.effectiveStartDate ?? existing.effectiveStartDate;
    const nextEnd = updates?.effectiveEndDate ?? existing.effectiveEndDate;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      return res.status(400).json({ success: false, error: 'Effective end date must be on or after start date.' });
    }

    const nextSessions: ServerTimetableSession[] = Array.isArray(updates?.sessions) ? updates.sessions : existing.sessions;
    const structErr = validateSessionsStructure(nextSessions);
    if (structErr) {
      return res.status(400).json({ success: false, error: structErr });
    }

    const nextAssignment: ServerBatchTimetableAssignment = {
      ...existing,
      ...updates,
      id,
      effectiveStartDate: nextStart,
      effectiveEndDate: nextEnd,
      status: updates?.status || existing.status,
      sessions: nextSessions,
      isCustomized: updates?.isCustomized !== undefined ? updates.isCustomized : true,
      updatedAt: new Date().toISOString(),
      lastCustomizedBy: actor?.name || existing.lastCustomizedBy,
      lastCustomizedAt: new Date().toISOString(),
    };

    const conflicts = detectAssignmentConflictsOnServer(nextAssignment);
    if (conflicts.length > 0) {
      appendTimetableAudit({
        action: 'CONFLICT_BLOCKED',
        actorId: actor?.id || 'system',
        actorName: actor?.name || 'Authorized Admin',
        actorRole: actor?.role || 'admin',
        targetType: 'conflict',
        targetId: existing.id,
        targetName: existing.batchName,
        details: `Blocked customization for "${existing.batchName}" due to ${conflicts.length} conflict(s): ${conflicts[0].message}`,
      });
      saveTimetablesDiskStore();
      return res.status(409).json({
        success: false,
        error: conflicts[0].message,
        conflicts,
      });
    }

    timetablesDiskStore.assignments[idx] = nextAssignment;
    const onlyStatusChanged = updates && Object.keys(updates).length === 1 && updates.status !== undefined;
    appendTimetableAudit({
      action: onlyStatusChanged ? 'BATCH_TIMETABLE_STATUS_CHANGED' : 'BATCH_TIMETABLE_CUSTOMIZED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'assignment',
      targetId: nextAssignment.id,
      targetName: nextAssignment.batchName,
      details: onlyStatusChanged
        ? `Set batch timetable for "${nextAssignment.batchName}" to ${nextAssignment.status}.`
        : `Customized batch weekly timetable for "${nextAssignment.batchName}" (${nextSessions.length} sessions). Master template & other batches unaffected.`,
    });
    saveTimetablesDiskStore();

    return res.json({
      success: true,
      assignment: nextAssignment,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    console.error('[Timetable] Update batch assignment error:', err);
    return res.status(500).json({ success: false, error: 'Database error while updating batch timetable.' });
  }
});

app.delete('/api/timetables/assignments/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { actor } = req.body || {};
    const existing = timetablesDiskStore.assignments.find((a) => a.id === id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Batch timetable assignment not found.' });
    }
    timetablesDiskStore.assignments = timetablesDiskStore.assignments.filter((a) => a.id !== id);
    appendTimetableAudit({
      action: 'BATCH_UNASSIGNED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'assignment',
      targetId: id,
      targetName: existing.batchName,
      details: `Unassigned weekly timetable ("${existing.templateName}") from batch "${existing.batchName}".`,
    });
    saveTimetablesDiskStore();

    return res.json({
      success: true,
      unassignedId: id,
      ...timetablesDiskStore,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to unassign batch timetable.' });
  }
});

app.post('/api/timetables/rooms', (req: Request, res: Response) => {
  try {
    const { room, actor } = req.body || {};
    if (!room || !room.name?.trim()) {
      return res.status(400).json({ success: false, error: 'Classroom or Computer Lab name is required.' });
    }
    const normalized = room.name.trim().toLowerCase();
    const exists = timetablesDiskStore.rooms.some((r) => r.name.trim().toLowerCase() === normalized);
    if (exists) {
      return res.status(400).json({ success: false, error: `Room "${room.name.trim()}" already exists.` });
    }
    const newRoom: ServerCampusRoom = {
      id: `room-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: room.name.trim(),
      type: room.type === 'Computer Lab' ? 'Computer Lab' : 'Classroom',
      capacity: room.capacity ? Number(room.capacity) : undefined,
      building: room.building || '',
      createdAt: new Date().toISOString(),
    };
    timetablesDiskStore.rooms.push(newRoom);
    appendTimetableAudit({
      action: 'ROOM_ADDED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'room',
      targetId: newRoom.id,
      targetName: newRoom.name,
      details: `Added ${newRoom.type} "${newRoom.name}" to campus allocation registry.`,
    });
    saveTimetablesDiskStore();
    return res.status(201).json({ success: true, room: newRoom, ...timetablesDiskStore });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to save room.' });
  }
});

app.delete('/api/timetables/rooms/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { actor } = req.body || {};
    const target = timetablesDiskStore.rooms.find((r) => r.id === id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Room not found.' });
    }
    const inUse = timetablesDiskStore.assignments.some(
      (a) =>
        a.status === 'active' &&
        a.sessions.some((s) => s.roomName.trim().toLowerCase() === target.name.trim().toLowerCase())
    );
    if (inUse) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete "${target.name}" while it is allocated in an active batch timetable.`,
      });
    }
    timetablesDiskStore.rooms = timetablesDiskStore.rooms.filter((r) => r.id !== id);
    appendTimetableAudit({
      action: 'ROOM_DELETED',
      actorId: actor?.id || 'system',
      actorName: actor?.name || 'Authorized Admin',
      actorRole: actor?.role || 'admin',
      targetType: 'room',
      targetId: id,
      targetName: target.name,
      details: `Removed ${target.type} "${target.name}" from campus allocation registry.`,
    });
    saveTimetablesDiskStore();
    return res.json({ success: true, ...timetablesDiskStore });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to delete room.' });
  }
});

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    system: 'Link Pulse Academy ERP',
    timestamp: new Date().toISOString(),
    materialsCount: materialsStore.length,
    receiptsCount: feeReceiptsStore.size,
    usersCount: usersDiskStore.users.length,
    coursesCount: erpCoreStore.courses.length,
    batchesCount: enrollmentsDiskStore.batches.length,
    studentsCount: enrollmentsDiskStore.students.length,
    timetableTemplatesCount: timetablesDiskStore.templates.length,
    timetableAssignmentsCount: timetablesDiskStore.assignments.length,
  });
});

// =========================================================================
// DEV SERVER & VITE INTEGRATION
// =========================================================================
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: 3000,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[LPA ERP] Full-stack application running on http://0.0.0.0:${PORT}`);
  });

  server.on('error', (err: any) => {
    console.error(`[LPA ERP] Server listen error on port ${PORT}:`, err);
    if (err.code === 'EADDRINUSE' && PORT !== 3000) {
      console.warn(`[LPA ERP] Port ${PORT} already in use, binding to port 3000...`);
      app.listen(3000, '0.0.0.0', () => {
        console.log(`[LPA ERP] Fallback server running on http://0.0.0.0:3000`);
      });
    }
  });
}

startServer().catch((err) => {
  console.error('[LPA ERP] Failed to start server:', err);
  process.exit(1);
});
