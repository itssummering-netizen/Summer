import React, { useState, useEffect, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { Dashboard } from './components/Dashboard';
import { Note, Folder } from './types';

// Helper to generate unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

const App: React.FC = () => {
  // --- NOTES STATE ---
  const [notes, setNotes] = useState<Note[]>(() => {
    const saved = localStorage.getItem('vn-notes-app-data');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return [];
      }
    }
    return [
      {
        id: 'welcome-note',
        title: 'Chào mừng đến với VN Notes',
        content: 'Đây là ứng dụng ghi chú đơn giản lấy cảm hứng từ Apple Notes.\n\nTính năng:\n- Tạo và quản lý ghi chú.\n- Tự động lưu.\n- Tích hợp Gemini AI để hỗ trợ viết (Sử dụng nút Đũa thần góc dưới phải).\n\nHãy thử tạo một ghi chú mới!',
        updatedAt: Date.now(),
        folder: 'Cá nhân'
      },
      {
        id: 'ideas-note',
        title: 'Ý tưởng dự án mới',
        content: '- Tích hợp Voice to Text\n- Chế độ tối (Dark Mode)\n- Chia sẻ ghi chú qua link',
        updatedAt: Date.now() - 100000,
        folder: 'Công việc'
      }
    ];
  });

  // --- FOLDERS STATE ---
  const [folders, setFolders] = useState<Folder[]>(() => {
    const savedFolders = localStorage.getItem('vn-notes-app-folders');
    if (savedFolders) {
      try {
        return JSON.parse(savedFolders);
      } catch (e) {
        return [];
      }
    }
    // Default folders if none exist
    return [
      { id: 'f-personal', name: 'Cá nhân', color: 'bg-blue-500', icon: 'user' },
      { id: 'f-work', name: 'Công việc', color: 'bg-orange-500', icon: 'briefcase' },
    ];
  });

  // Navigation State
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<'dashboard' | 'trash'>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Mobile responsiveness
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Persistence
  useEffect(() => {
    localStorage.setItem('vn-notes-app-data', JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    localStorage.setItem('vn-notes-app-folders', JSON.stringify(folders));
  }, [folders]);

  // Adjust sidebar for mobile on load and resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        if (activeNoteId) setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
      }
    };
    
    // Initial check
    if (window.innerWidth < 768 && activeNoteId) {
      setIsSidebarOpen(false);
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeNoteId]);

  // --- FILTERED DATA FOR UI ---
  // Only show non-deleted items in main views
  const activeNotes = useMemo(() => notes.filter(n => !n.deletedAt), [notes]);
  const activeFolders = useMemo(() => folders.filter(f => !f.deletedAt), [folders]);
  
  // Trash items
  const trashFolders = useMemo(() => folders.filter(f => f.deletedAt), [folders]);
  
  // Revised Trash Notes Logic:
  // 1. Must be deleted (deletedAt is set).
  // 2. If the folder it belongs to is ALSO in the trash, do NOT show the note individually 
  //    (because it is conceptually inside the displayed trash folder).
  const trashNotes = useMemo(() => {
      const deletedFolderNames = new Set(trashFolders.map(f => f.name));
      
      return notes.filter(n => {
          if (!n.deletedAt) return false;
          
          // If note belongs to a deleted folder, hide it from the standalone list
          if (n.folder && n.folder !== 'Chung' && deletedFolderNames.has(n.folder)) {
              return false;
          }
          
          return true;
      });
  }, [notes, trashFolders]);

  // All trash notes (for counting purposes in Dashboard)
  const allTrashNotes = useMemo(() => notes.filter(n => n.deletedAt), [notes]);

  // --- NOTE OPERATIONS ---

  const addNote = () => {
    const newNote: Note = {
      id: generateId(),
      title: '',
      content: '',
      updatedAt: Date.now(),
      folder: 'Chung' // Default folder
    };
    setNotes([newNote, ...notes]);
    setActiveNoteId(newNote.id);
    setCurrentView('dashboard'); // Switch back to dashboard context if in trash
    // On mobile, switch to editor immediately
    if (window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
  };

  const deleteNote = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isPermanent = currentView === 'trash';
    
    if (isPermanent) {
        if (window.confirm("Xóa vĩnh viễn ghi chú này? Hành động này không thể hoàn tác.")) {
            setNotes(prev => prev.filter(n => n.id !== id));
        }
    } else {
        // Soft delete
        setNotes(prev => prev.map(n => n.id === id ? { ...n, deletedAt: Date.now() } : n));
    }
    
    if (activeNoteId === id) {
      setActiveNoteId(null);
    }
  };

  const updateNote = (id: string, updates: Partial<Note>) => {
    setNotes((prevNotes) =>
      prevNotes.map((note) => (note.id === id ? { ...note, ...updates } : note))
    );
  };

  const handleSelectNote = (id: string) => {
    setActiveNoteId(id);
    if (window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
  };

  // --- FOLDER OPERATIONS ---

  const addFolder = (folderData: Omit<Folder, 'id'>) => {
    const newFolder: Folder = {
      id: generateId(),
      ...folderData
    };
    setFolders([...folders, newFolder]);
  };

  const updateFolder = (id: string, updates: Partial<Folder>) => {
    const oldFolder = folders.find(f => f.id === id);
    
    setFolders(prevFolders => 
      prevFolders.map(f => f.id === id ? { ...f, ...updates } : f)
    );

    // If name changed, update all notes belonging to this folder
    if (oldFolder && updates.name && oldFolder.name !== updates.name) {
      setNotes(prevNotes => 
        prevNotes.map(n => 
          n.folder === oldFolder.name ? { ...n, folder: updates.name } : n
        )
      );
    }
  };

  const deleteFolder = (id: string) => {
    const folderToDelete = folders.find(f => f.id === id);
    if (!folderToDelete) return;
    
    // Moved to trash immediately without confirmation for better UX
    const timestamp = Date.now();
    
    // 1. Soft delete the folder
    setFolders(prev => prev.map(f => f.id === id ? { ...f, deletedAt: timestamp } : f));

    // 2. Soft delete all notes in that folder
    setNotes(prevNotes => 
    prevNotes.map(n => 
        n.folder === folderToDelete.name ? { ...n, deletedAt: timestamp } : n
    )
    );
  };

  // --- TRASH OPERATIONS ---

  const emptyTrash = () => {
      if (window.confirm("Bạn có chắc chắn muốn xóa vĩnh viễn tất cả mọi thứ trong thùng rác?")) {
          // Permanently remove ALL items marked as deleted
          // This includes standalone deleted notes AND notes inside deleted folders
          setNotes(prev => prev.filter(n => !n.deletedAt));
          setFolders(prev => prev.filter(f => !f.deletedAt));
      }
  };

  const restoreItem = (type: 'note' | 'folder', id: string) => {
      if (type === 'note') {
          setNotes(prev => prev.map(n => n.id === id ? { ...n, deletedAt: undefined } : n));
      } else {
          // Restore folder and its notes
          const folder = folders.find(f => f.id === id);
          if (folder) {
              setFolders(prev => prev.map(f => f.id === id ? { ...f, deletedAt: undefined } : f));
              // Restore notes belonging to this folder that were also deleted
              setNotes(prev => prev.map(n => n.folder === folder.name && n.deletedAt ? { ...n, deletedAt: undefined } : n));
          }
      }
  };

  // --- NAVIGATION ---

  const handleBackToSidebar = () => {
    setIsSidebarOpen(true);
  };
  
  const handleGoHome = () => {
      setActiveNoteId(null);
      setCurrentView('dashboard');
      setIsSidebarOpen(true);
  };
  
  const handleGoTrash = () => {
      setActiveNoteId(null);
      setCurrentView('trash');
      setIsSidebarOpen(true);
  };

  const activeNote = notes.find((n) => n.id === activeNoteId);

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Sidebar - Conditional rendering for mobile */}
      <div className={`${isSidebarOpen ? 'w-full md:w-80' : 'hidden md:block w-80'} h-full flex-shrink-0 transition-all`}>
        <Sidebar
          notes={currentView === 'trash' ? trashNotes : activeNotes}
          activeNoteId={activeNoteId}
          onSelectNote={handleSelectNote}
          onDeleteNote={deleteNote}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onGoHome={handleGoHome}
          currentView={currentView}
        />
      </div>

      {/* Main Area: Shows Editor if note selected, otherwise Dashboard */}
      <div className={`flex-1 h-full ${!isSidebarOpen ? 'block' : 'hidden md:block'}`}>
        {activeNote ? (
          <Editor 
            note={activeNote} 
            folders={activeFolders} // Only allow moving to active folders
            onUpdateNote={updateNote} 
            onBack={handleBackToSidebar}
          />
        ) : (
          <Dashboard 
            notes={currentView === 'trash' ? trashNotes : activeNotes} 
            allNotes={currentView === 'trash' ? allTrashNotes : activeNotes}
            folders={currentView === 'trash' ? trashFolders : activeFolders}
            onSelectNote={handleSelectNote} 
            onAddFolder={addFolder}
            onUpdateFolder={updateFolder}
            onDeleteFolder={deleteFolder}
            // Add note operations
            onAddNote={addNote}
            onUpdateNote={updateNote}
            onDeleteNote={deleteNote}
            onGoTrash={handleGoTrash}
            isTrashView={currentView === 'trash'}
            onEmptyTrash={emptyTrash}
            onRestoreItem={restoreItem}
          />
        )}
      </div>
    </div>
  );
};

export default App;