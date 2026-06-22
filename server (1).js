const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "VoicePrint backend is running" });
});

const upload = multer({ dest: 'uploads/' });

// --- In-memory state ---
let printers = [
  { id: 'p1', name: 'HP LaserJet Pro', ip: '192.168.1.101', status: 'ready', type: 'laser', paperLevel: 85, inkLevel: 72 },
  { id: 'p2', name: 'Canon PIXMA', ip: '192.168.1.102', status: 'ready', type: 'inkjet', paperLevel: 60, inkLevel: 45 },
  { id: 'p3', name: 'Epson EcoTank', ip: '192.168.1.103', status: 'busy', type: 'inkjet', paperLevel: 30, inkLevel: 90 },
];

let printJobs = [];
let jobCounter = 1;

// --- REST API ---

// Get all discovered printers
app.get('/api/printers', (req, res) => {
  res.json({ printers, timestamp: Date.now() });
});

// Refresh/scan for printers (simulates Bonjour/mDNS discovery)
app.post('/api/printers/scan', (req, res) => {
  io.emit('scan-started', { message: 'Scanning for nearby printers...' });

  setTimeout(() => {
    // Simulate finding a new printer
    const newPrinter = {
      id: 'p4',
      name: 'Brother HL-L2350DW',
      ip: '192.168.1.104',
      status: 'ready',
      type: 'laser',
      paperLevel: 95,
      inkLevel: 80
    };
    if (!printers.find(p => p.id === 'p4')) {
      printers.push(newPrinter);
      io.emit('printer-discovered', { printer: newPrinter });
    }
    io.emit('scan-complete', { count: printers.length, message: `Found ${printers.length} printer${printers.length !== 1 ? 's' : ''}` });
  }, 3000);

  res.json({ status: 'scanning' });
});

// Get all print jobs
app.get('/api/jobs', (req, res) => {
  res.json({ jobs: printJobs });
});

// Submit a print job
app.post('/api/print', upload.single('file'), (req, res) => {
  const { printerId, copies = 1, color = false, duplex = false, documentName } = req.body;
  const printer = printers.find(p => p.id === printerId);

  if (!printer) {
    return res.status(404).json({ error: 'Printer not found' });
  }
  if (printer.status === 'offline') {
    return res.status(400).json({ error: 'Printer is offline' });
  }

  const job = {
    id: `job-${jobCounter++}`,
    printerId,
    printerName: printer.name,
    documentName: documentName || req.file?.originalname || 'Untitled Document',
    copies: parseInt(copies),
    color: color === 'true',
    duplex: duplex === 'true',
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    filePath: req.file?.path || null,
  };

  printJobs.unshift(job);
  io.emit('job-queued', { job });
  io.emit('speak', { text: `Print job queued. Printing ${job.documentName} on ${printer.name}.` });

  // Simulate printing
  simulatePrinting(job, printer);

  res.json({ job });
});

// Cancel a print job
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = printJobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (['done', 'failed'].includes(job.status)) {
    return res.status(400).json({ error: 'Cannot cancel a completed job' });
  }
  job.status = 'cancelled';
  io.emit('job-cancelled', { job });
  io.emit('speak', { text: `Print job for ${job.documentName} has been cancelled.` });
  res.json({ job });
});

// Voice command processing
app.post('/api/voice-command', (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const result = processVoiceCommand(transcript.toLowerCase());
  res.json(result);
});

function processVoiceCommand(text) {
  // SCAN printers
  if (/scan|find|search|discover|look for|nearby|available/.test(text)) {
    return { action: 'scan', message: 'Scanning for nearby printers' };
  }

  // LIST printers
  if (/list|show|what printers|available printers|which printer/.test(text)) {
    const names = printers.filter(p => p.status !== 'offline').map(p => p.name).join(', ');
    return { action: 'list-printers', message: `Available printers: ${names || 'None found'}`, printers };
  }

  // PRINT command — "print [document] on [printer]" or "print [document]"
  if (/print|send to printer/.test(text)) {
    let printerId = null;
    const readyPrinters = printers.filter(p => p.status === 'ready');

    // Try to match printer name
    for (const p of printers) {
      if (text.includes(p.name.toLowerCase()) || text.includes(p.id)) {
        printerId = p.id;
        break;
      }
    }

    // Default to first ready printer
    if (!printerId && readyPrinters.length > 0) {
      printerId = readyPrinters[0].id;
    }

    // Extract copies
    const copiesMatch = text.match(/(\d+)\s+cop(?:y|ies)/);
    const copies = copiesMatch ? parseInt(copiesMatch[1]) : 1;

    const color = /color|colour/.test(text);
    const duplex = /double.?sided|duplex|both sides/.test(text);

    if (printerId) {
      const printer = printers.find(p => p.id === printerId);
      return {
        action: 'print',
        printerId,
        copies,
        color,
        duplex,
        message: `Printing on ${printer.name}`,
      };
    } else {
      return { action: 'error', message: 'No printer available. Please scan for printers first.' };
    }
  }

  // CANCEL
  if (/cancel|stop/.test(text)) {
    const activeJob = printJobs.find(j => j.status === 'printing' || j.status === 'queued');
    if (activeJob) {
      return { action: 'cancel', jobId: activeJob.id, message: `Cancelling print job for ${activeJob.documentName}` };
    }
    return { action: 'error', message: 'No active print jobs to cancel.' };
  }

  // STATUS
  if (/status|how many|progress|jobs/.test(text)) {
    const active = printJobs.filter(j => ['queued', 'printing'].includes(j.status));
    return { action: 'status', message: `You have ${active.length} active print job${active.length !== 1 ? 's' : ''}.`, jobs: active };
  }

  // HELP
  if (/help|what can|commands|how do/.test(text)) {
    return {
      action: 'help',
      message: 'You can say: scan for printers, list printers, print document, cancel print, or check status.'
    };
  }

  return { action: 'unknown', message: `I didn't understand "${text}". Say "help" for available commands.` };
}

function simulatePrinting(job, printer) {
  printer.status = 'busy';
  io.emit('printer-status', { printerId: printer.id, status: 'busy' });

  job.status = 'printing';
  io.emit('job-update', { job });

  const totalSteps = 20;
  let step = 0;

  const interval = setInterval(() => {
    if (job.status === 'cancelled') {
      clearInterval(interval);
      printer.status = 'ready';
      io.emit('printer-status', { printerId: printer.id, status: 'ready' });
      return;
    }

    step++;
    job.progress = Math.round((step / totalSteps) * 100);
    io.emit('job-progress', { jobId: job.id, progress: job.progress });

    if (step >= totalSteps) {
      clearInterval(interval);
      job.status = 'done';
      job.progress = 100;
      printer.status = 'ready';
      io.emit('job-update', { job });
      io.emit('printer-status', { printerId: printer.id, status: 'ready' });
      io.emit('speak', { text: `Printing complete. ${job.documentName} has been printed successfully on ${printer.name}.` });
    }
  }, 500);
}

// WebSocket
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('init', { printers, jobs: printJobs.slice(0, 20) });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Printer backend running on http://0.0.0.0:${PORT}`);
});
