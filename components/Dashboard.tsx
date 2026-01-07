import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Note, Folder as FolderType } from '../types';
import { 
  Folder, Clock, FileText, ChevronRight, Briefcase, User, 
  Heart, Star, Book, Coffee, Music, Layout, X,
  ArrowLeft, Trash2, PenLine, MoreHorizontal, Plus, RotateCcw,
  FolderInput, Check, FilePlus, FolderPlus
} from 'lucide-react';

interface DashboardProps {
  notes: Note[];
  folders: FolderType[];
  allNotes?: Note[]; // Added for accurate stats calculation
  onSelectNote: (id: string) => void;
  onAddFolder: (folder: Omit<FolderType, 'id'>) => void;
  onUpdateFolder: (id: string, updates: Partial<FolderType>) => void;
  onDeleteFolder: (id: string) => void;
  // Note actions
  onAddNote: () => void;
  onUpdateNote?: (id: string, updates: Partial<Note>) => void;
  onDeleteNote?: (id: string, e: React.MouseEvent) => void;
  
  onGoTrash: () => void;
  isTrashView?: boolean;
  onEmptyTrash?: () => void;
  onRestoreItem?: (type: 'note' | 'folder', id: string) => void;
}

// Icon mapping
const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  briefcase: Briefcase,
  user: User,
  heart: Heart,
  star: Star,
  book: Book,
  coffee: Coffee,
  music: Music,
  layout: Layout
};

// Vertical Gradient mapping: #f1f1f1 (top) -> color (bottom)
const GRADIENT_MAP: Record<string, string> = {
  blue: 'to-blue-100',
  orange: 'to-orange-100',
  green: 'to-green-100',
  red: 'to-red-100',
  purple: 'to-purple-100',
  pink: 'to-pink-100',
  gray: 'to-gray-200',
};

const TEXT_COLOR_MAP: Record<string, string> = {
  blue: 'text-blue-600',
  orange: 'text-orange-600',
  green: 'text-green-600',
  red: 'text-red-600',
  purple: 'text-purple-600',
  pink: 'text-pink-600',
  gray: 'text-gray-600',
};

// Map for Tag backgrounds (Light pastel bg + White text + 50% Opacity)
const TAG_BG_MAP: Record<string, string> = {
  blue: 'bg-blue-400/50 text-white',
  orange: 'bg-orange-400/50 text-white',
  green: 'bg-green-400/50 text-white',
  red: 'bg-red-400/50 text-white',
  purple: 'bg-purple-400/50 text-white',
  pink: 'bg-pink-400/50 text-white',
  gray: 'bg-gray-400/50 text-white',
};

// Classes for the color picker preview
const COLOR_OPTIONS = [
    { id: 'blue', class: 'bg-blue-500' },
    { id: 'orange', class: 'bg-orange-500' },
    { id: 'green', class: 'bg-green-500' },
    { id: 'red', class: 'bg-red-500' },
    { id: 'purple', class: 'bg-purple-500' },
    { id: 'pink', class: 'bg-pink-500' },
    { id: 'gray', class: 'bg-gray-500' },
];

export const Dashboard: React.FC<DashboardProps> = ({ 
  notes, 
  folders,
  allNotes, 
  onSelectNote,
  onAddFolder,
  onUpdateFolder,
  onDeleteFolder,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onGoTrash,
  isTrashView = false,
  onEmptyTrash,
  onRestoreItem
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [viewingFolder, setViewingFolder] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'folders' | 'notes'>('folders');
  
  // State for the "More" dropdown menu (folders)
  const [openMenuFolderId, setOpenMenuFolderId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // State for "Move Note" dropdown
  const [moveMenuNoteId, setMoveMenuNoteId] = useState<string | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);

  // State for Floating Create Button
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  // Form State
  const [folderName, setFolderName] = useState('');
  const [selectedIcon, setSelectedIcon] = useState('folder');
  const [selectedColor, setSelectedColor] = useState('bg-blue-500');

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuFolderId(null);
      }
      if (moveMenuRef.current && !moveMenuRef.current.contains(event.target as Node)) {
        setMoveMenuNoteId(null);
      }
      // Removed createMenuRef check because we use hover now
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Calculate folder statistics
  const folderStats = useMemo(() => {
    // Use allNotes if provided (e.g., in Trash View to include notes inside deleted folders), otherwise use displayed notes
    const notesToCount = allNotes || notes;

    // Count notes per folder name
    const counts: Record<string, number> = {};
    let uncategorizedCount = 0;
    let trashCount = 0;

    notesToCount.forEach(note => {
      if (note.deletedAt) {
          trashCount++;
      } else if (note.folder && note.folder !== 'Chung') {
        counts[note.folder] = (counts[note.folder] || 0) + 1;
      } else {
        uncategorizedCount++;
      }
    });
    
    return {
      mapped: mappedFolders,
      uncategorized: uncategorizedCount
    };
    
    function mappedFolders() {
        return folders.map(f => ({
            ...f,
            count: counts[f.name] || 0
        }));
    }

  }, [notes, allNotes, folders]);

  // Filter notes based on view (All or specific folder)
  const displayedNotes = useMemo(() => {
    let filtered = notes;
    
    if (viewingFolder === 'Chung') {
      filtered = notes.filter(n => !n.folder || n.folder === 'Chung');
    } else if (viewingFolder) {
      filtered = notes.filter(n => n.folder === viewingFolder);
    }

    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, viewingFolder]);

  const formatDate = (timestamp: number) => {
    return new Intl.DateTimeFormat('vi-VN', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric'
    }).format(new Date(timestamp));
  };
  
  // Helper for word truncation - UPDATED TO 12 WORDS
  const getTruncatedContent = (content: string) => {
      if (!content) return <span className="italic opacity-50">...</span>;
      const words = content.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
      if (words.length <= 12) return words.join(' ');
      return words.slice(0, 12).join(' ') + '...';
  };

  const handleOpenModal = (folder?: FolderType) => {
    setOpenMenuFolderId(null); // Close menu if open
    setShowCreateMenu(false); // Close create menu if open
    if (folder) {
      setEditingFolderId(folder.id);
      setFolderName(folder.name);
      setSelectedIcon(folder.icon);
      setSelectedColor(folder.color);
    } else {
      setEditingFolderId(null);
      setFolderName('');
      setSelectedIcon('folder');
      setSelectedColor('bg-blue-500');
    }
    setIsModalOpen(true);
  };

  const handleCreateNote = () => {
      setShowCreateMenu(false);
      onAddNote();
  };

  const handleSave = () => {
    if (!folderName.trim()) return;

    if (editingFolderId) {
      onUpdateFolder(editingFolderId, {
        name: folderName,
        icon: selectedIcon,
        color: selectedColor
      });
      if (viewingFolder && viewingFolder !== folderName) {
          setViewingFolder(folderName);
      }
    } else {
      onAddFolder({
        name: folderName,
        icon: selectedIcon,
        color: selectedColor
      });
    }
    setIsModalOpen(false);
  };
  
  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setOpenMenuFolderId(null);
      onDeleteFolder(id);
      if (viewingFolder) setViewingFolder(null);
  };

  const handleRestoreClick = (e: React.MouseEvent, type: 'note' | 'folder', id: string) => {
      e.stopPropagation();
      setOpenMenuFolderId(null);
      if (onRestoreItem) onRestoreItem(type, id);
  };

  const handleEditClick = (e: React.MouseEvent, folder: FolderType) => {
      e.stopPropagation();
      handleOpenModal(folder);
  };
  
  const toggleMenu = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setOpenMenuFolderId(openMenuFolderId === id ? null : id);
  };
  
  // Note Actions
  const toggleMoveMenu = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setMoveMenuNoteId(moveMenuNoteId === id ? null : id);
  };

  const handleMoveNote = (e: React.MouseEvent, noteId: string, targetFolder: string) => {
      e.stopPropagation();
      if (onUpdateNote) {
          onUpdateNote(noteId, { folder: targetFolder });
      }
      setMoveMenuNoteId(null);
  };
  
  const handleDeleteNoteClick = (e: React.MouseEvent, noteId: string) => {
      e.stopPropagation(); // Prevent opening note
      if (onDeleteNote) {
          onDeleteNote(noteId, e);
      }
  };

  return (
    <div className="relative h-full">
        <div className="h-full overflow-y-auto bg-gray-50/50 p-6 md:p-10">
            {/* Reduced max-w and spacing */}
            <div className="max-w-7xl mx-auto space-y-8 pb-24">
                
                {/* Header */}
                <div>
                {viewingFolder ? (
                    <div className="flex items-center gap-4 mb-2">
                        <button 
                            onClick={() => setViewingFolder(null)}
                            className="p-2 rounded-full hover:bg-gray-200 transition-colors -ml-2 text-gray-600"
                        >
                            <ArrowLeft size={28} />
                        </button>
                        <h1 className="text-4xl font-bold text-gray-900 tracking-tight">{viewingFolder}</h1>
                    </div>
                ) : (
                    <div className="flex flex-col gap-8">
                        <div>
                            <h1 className="text-4xl font-bold text-gray-900 tracking-tight">
                                {isTrashView ? 'Thùng rác' : 'Tổng quan'}
                            </h1>
                        </div>

                         {/* Toggle Bar - Only for main Dashboard */}
                         {!isTrashView && (
                            <div className="flex items-center bg-gray-100 p-1.5 rounded-full w-fit">
                                <button
                                    onClick={() => setActiveTab('folders')}
                                    className={`px-6 py-2 rounded-full text-lg md:text-xl font-bold transition-all duration-300 ${
                                        activeTab === 'folders' 
                                        ? 'text-gray-900 opacity-100' 
                                        : 'text-gray-900 opacity-20 hover:opacity-40'
                                    }`}
                                >
                                    Thư mục
                                </button>
                                <button
                                    onClick={() => setActiveTab('notes')}
                                    className={`px-6 py-2 rounded-full text-lg md:text-xl font-bold transition-all duration-300 ${
                                        activeTab === 'notes' 
                                        ? 'text-gray-900 opacity-100' 
                                        : 'text-gray-900 opacity-20 hover:opacity-40'
                                    }`}
                                >
                                    Ghi chú
                                </button>
                            </div>
                        )}
                    </div>
                )}
                </div>

                {/* Folders Section - Show if (Not Viewing Folder AND (ActiveTab is Folders OR Trash View)) */}
                {(!viewingFolder && (activeTab === 'folders' || isTrashView)) && (
                    <section>
                    {/* Header - Hidden in Trash View */}
                    {!isTrashView && (
                        <div className="flex items-center justify-between mb-5">
                            {/* Hidden as per user request to use toggle instead of headers */}
                        </div>
                    )}
                    
                    {/* Responsive Grid Layout - Added responsive GAP */}
                    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 sm:gap-4 md:gap-6">
                        
                        {/* System/Uncategorized Folder - Only show if not Trash View */}
                        {!isTrashView && (
                            <div 
                                onClick={() => setViewingFolder('Chung')}
                                className="w-full bg-gradient-to-b from-[#f1f1f1] to-gray-200 p-6 rounded-[2rem] hover:scale-[1.02] transition-all duration-300 cursor-pointer group flex flex-col justify-between h-56 border border-white/60 relative overflow-hidden"
                            >
                                <div className="flex justify-between items-start z-10">
                                        {/* Icon Left */}
                                    <div className="w-14 h-14 rounded-2xl bg-white/80 backdrop-blur-sm text-gray-500 flex items-center justify-center">
                                        <Folder size={28} strokeWidth={2} />
                                    </div>
                                </div>

                                <div className="flex justify-between items-end z-10">
                                        {/* Title Left */}
                                    <div>
                                        <h3 className="text-2xl font-bold text-gray-800 truncate mb-1">Chung</h3>
                                        {/* Subtitle removed */}
                                    </div>
                                    
                                    {/* Count Right - Lower opacity */}
                                    <span className="text-4xl font-bold text-gray-800/40">{folderStats.uncategorized}</span>
                                </div>
                            </div>
                        )}

                        {/* User Folders */}
                        {folderStats.mapped().map((folder) => {
                        const IconComponent = ICON_MAP[folder.icon] || Folder;
                        const colorName = folder.color.split('-')[1] || 'gray';
                        const toColorClass = GRADIENT_MAP[colorName] || 'to-gray-100';
                        const iconColorClass = TEXT_COLOR_MAP[colorName] || 'text-gray-600';
                        
                        const isMenuOpen = openMenuFolderId === folder.id;

                        return (
                            <div 
                            key={folder.id} 
                            onClick={() => !isTrashView && setViewingFolder(folder.name)}
                            className={`w-full bg-gradient-to-b from-[#f1f1f1] ${toColorClass} p-6 rounded-[2rem] hover:scale-[1.02] transition-all duration-300 cursor-pointer group relative flex flex-col justify-between h-56 border border-white/60`}
                            >
                                {/* Top Row */}
                                <div className="flex justify-between items-start">
                                    {/* Icon Left */}
                                    <div className={`w-14 h-14 rounded-2xl bg-white/60 backdrop-blur-sm ${iconColorClass} flex items-center justify-center group-hover:scale-105 transition-transform`}>
                                        <IconComponent size={28} strokeWidth={2} />
                                    </div>
                                    
                                    {/* Menu Button Right or Restore */}
                                    <div className="relative">
                                        {isTrashView ? (
                                            <button 
                                                onClick={(e) => handleRestoreClick(e, 'folder', folder.id)}
                                                className="p-2 rounded-full hover:bg-white/80 text-green-600 bg-white/50"
                                                title="Khôi phục"
                                            >
                                                <RotateCcw size={24} />
                                            </button>
                                        ) : (
                                            <>
                                                <button 
                                                    onClick={(e) => toggleMenu(e, folder.id)}
                                                    className={`p-2 rounded-full hover:bg-white/80 transition-colors ${isMenuOpen ? 'bg-white/80 text-gray-800' : 'text-gray-400 hover:text-gray-600'}`}
                                                >
                                                    <MoreHorizontal size={24} />
                                                </button>
                                                
                                                {/* Dropdown Menu */}
                                                {isMenuOpen && (
                                                    <div ref={menuRef} className="absolute top-full right-0 mt-2 w-48 bg-white rounded-xl border border-gray-100 overflow-hidden z-20 animate-in fade-in zoom-in-95 duration-100 shadow-xl">
                                                        <button 
                                                            onClick={(e) => handleEditClick(e, folder)}
                                                            className="w-full text-left px-5 py-3.5 text-[15px] text-gray-700 hover:bg-gray-50 flex items-center gap-3 font-medium"
                                                        >
                                                            <PenLine size={18} /> Chỉnh sửa
                                                        </button>
                                                        <div className="h-px bg-gray-100 w-full"></div>
                                                        <button 
                                                            onClick={(e) => handleDeleteClick(e, folder.id)}
                                                            className="w-full text-left px-5 py-3.5 text-[15px] text-red-600 hover:bg-red-50 flex items-center gap-3 font-medium"
                                                        >
                                                            <Trash2 size={18} /> Xóa
                                                        </button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Bottom Row */}
                                <div className="flex justify-between items-end">
                                    {/* Title Left */}
                                    <div>
                                        <h3 className="text-2xl font-bold text-gray-900 truncate pr-2 mb-1 max-w-[180px]">{folder.name}</h3>
                                        {/* Subtitle removed */}
                                    </div>
                                    
                                    {/* Count Right - Lower opacity */}
                                    <span className="text-4xl font-bold text-gray-800/40">{folder.count}</span>
                                </div>
                            </div>
                        );
                        })}
                        
                        {/* TRASH FOLDER CARD - Moved here from Sidebar/Top */}
                        {!isTrashView && (
                             <div 
                                onClick={onGoTrash}
                                className="w-full bg-gradient-to-b from-[#f1f1f1] to-red-100 p-6 rounded-[2rem] hover:scale-[1.02] transition-all duration-300 cursor-pointer group flex flex-col justify-between h-56 border border-white/60 relative overflow-hidden"
                            >
                                <div className="flex justify-between items-start z-10">
                                    <div className="w-14 h-14 rounded-2xl bg-white/80 backdrop-blur-sm text-red-500 flex items-center justify-center">
                                        <Trash2 size={28} strokeWidth={2} />
                                    </div>
                                </div>

                                <div className="flex justify-between items-end z-10">
                                    <div>
                                        <h3 className="text-2xl font-bold text-gray-800 truncate mb-1">Ghi chú đã xóa</h3>
                                        {/* Subtitle removed */}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    </section>
                )}

                {/* Notes Grid Section - Show if (Viewing Folder OR (ActiveTab is Notes OR Trash View)) */}
                {(viewingFolder || activeTab === 'notes' || isTrashView) && (
                <section>
                {/* Header - Hidden in Trash View OR when viewing a specific folder (since main title covers it) */}
                {!isTrashView && !viewingFolder && (
                     <div className="flex items-center justify-between mb-4 mt-2">
                         {/* Hidden as per user request */}
                     </div>
                )}
                
                {displayedNotes.length === 0 ? (
                    !isTrashView ? (
                        <div className="text-center py-16 bg-white rounded-3xl border border-gray-100">
                            <FileText className="w-16 h-16 text-gray-200 mx-auto mb-4" />
                            <p className="text-gray-400 text-lg">Không có ghi chú nào</p>
                        </div>
                    ) : null
                ) : (
                    // Responsive Grid - Same as Folders (Added responsive GAP)
                    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 sm:gap-4 md:gap-6">
                    {displayedNotes.map((note) => {
                        // Determine tag style
                        const noteFolder = folders.find(f => f.name === note.folder);
                        const colorName = noteFolder?.color.split('-')[1] || 'gray';
                        const tagClass = TAG_BG_MAP[colorName] || 'bg-gray-400/50 text-white';

                        return (
                        <div 
                        key={note.id}
                        onClick={() => !isTrashView && onSelectNote(note.id)}
                        // Adjusted height to h-[180px] for even shorter card
                        className={`w-full bg-white p-5 rounded-3xl border border-gray-200 hover:border-gray-300 transition-all flex flex-col h-[180px] group relative ${!isTrashView ? 'cursor-pointer' : ''}`}
                        >
                        {/* Top Metadata - Compacted MB to 2 */}
                        <div className="flex justify-between items-start mb-2">
                            <span className={`text-[10px] font-medium tracking-wider capitalize px-2.5 py-1 rounded-full max-w-[120px] truncate ${tagClass}`}>
                                {note.folder || 'Chung'}
                            </span>
                        </div>
                        
                        {/* Content Body - Grouped Title & Content with Gap-1 */}
                        <div className="flex-1 flex flex-col gap-1 overflow-hidden">
                            {/* Title - Reduced to text-lg and mb-0 */}
                            <h3 className="font-bold text-lg text-gray-900 leading-tight group-hover:text-blue-600 transition-colors line-clamp-2">
                                {note.title || 'Ghi chú chưa đặt tên'}
                            </h3>
                            
                            {/* Content reduced to line-clamp-2 to fit 180px */}
                            <p className="text-gray-500 text-sm leading-relaxed break-words whitespace-pre-wrap line-clamp-2">
                                {getTruncatedContent(note.content)}
                            </p>
                        </div>
                        
                        {/* Footer / Actions - Margin Auto ensures it sits at bottom */}
                        {isTrashView ? (
                            <div className="mt-2 pt-3 border-t border-gray-100 flex justify-between items-center">
                                <span className="text-xs text-gray-400 font-medium">{formatDate(note.updatedAt)}</span>
                                <button 
                                    onClick={(e) => handleRestoreClick(e, 'note', note.id)}
                                    className="text-green-600 text-sm font-medium hover:bg-green-50 px-3 py-1.5 rounded-lg transition-colors"
                                >
                                    Khôi phục
                                </button>
                            </div>
                        ) : (
                            <div className="mt-2 pt-3 border-t border-gray-50 flex justify-between items-center">
                                <span className="text-xs text-gray-400 font-medium">{formatDate(note.updatedAt)}</span>
                                
                                <div className="flex items-center gap-1">
                                    {/* Move Button */}
                                    <div className="relative">
                                        <button 
                                            onClick={(e) => toggleMoveMenu(e, note.id)}
                                            className="p-2 rounded-full text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-all"
                                            title="Di chuyển"
                                        >
                                            <FolderInput size={18} />
                                        </button>
                                        
                                        {moveMenuNoteId === note.id && (
                                            <div ref={moveMenuRef} className="absolute bottom-full right-0 mb-2 w-40 bg-white border border-gray-100 rounded-xl shadow-xl z-20 overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-100">
                                                <div className="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-50">
                                                    Chuyển đến
                                                </div>
                                                <button
                                                    onClick={(e) => handleMoveNote(e, note.id, 'Chung')}
                                                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center justify-between"
                                                >
                                                    Chung
                                                    {(!note.folder || note.folder === 'Chung') && <Check size={14} className="text-blue-500"/>}
                                                </button>
                                                {folders.map(f => (
                                                    <button
                                                        key={f.id}
                                                        onClick={(e) => handleMoveNote(e, note.id, f.name)}
                                                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center justify-between"
                                                    >
                                                        <span className="truncate">{f.name}</span>
                                                        {note.folder === f.name && <Check size={14} className="text-blue-500"/>}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Delete Button */}
                                    <button 
                                        onClick={(e) => handleDeleteNoteClick(e, note.id)}
                                        className="p-2 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all"
                                        title="Xóa"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        )}
                        </div>
                    )})}
                    </div>
                )}
                </section>
                )}
            </div>
        </div>

        {/* Empty Trash Button (In Trash View) */}
        {isTrashView && (notes.length > 0 || folders.length > 0) && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30">
                <button 
                    onClick={onEmptyTrash}
                    className="w-20 h-20 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-2xl shadow-red-500/40 flex items-center justify-center transition-all hover:scale-110 active:scale-95 group"
                    title="Dọn sạch thùng rác"
                >
                    <Trash2 size={32} strokeWidth={2.5} className="group-hover:rotate-12 transition-transform" />
                </button>
            </div>
        )}

        {/* Floating Create Button (Main View only) */}
        {!isTrashView && (
            <div 
                className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center" 
                ref={createMenuRef}
                onMouseEnter={() => setShowCreateMenu(true)}
                onMouseLeave={() => setShowCreateMenu(false)}
            >
                 {/* Create Menu - Added fly-in and scale animation - Start position adjustment (translate-y-4) and padding increase (pb-8) */}
                <div className={`absolute bottom-full pb-8 flex flex-col gap-2 transition-all duration-300 ease-out origin-bottom w-max ${showCreateMenu ? 'opacity-100 translate-y-0 scale-100 visible' : 'opacity-0 translate-y-4 scale-90 invisible'}`}>
                    <button 
                        onClick={handleCreateNote}
                        className="flex items-center gap-3 px-6 py-3 bg-white text-gray-800 rounded-2xl shadow-xl border border-gray-100 whitespace-nowrap cursor-pointer"
                    >
                        <FilePlus size={20} className="text-blue-500" />
                        <span className="font-semibold">Ghi chú mới</span>
                    </button>
                    <button 
                        onClick={() => handleOpenModal()}
                        className="flex items-center gap-3 px-6 py-3 bg-white text-gray-800 rounded-2xl shadow-xl border border-gray-100 whitespace-nowrap cursor-pointer"
                    >
                        <FolderPlus size={20} className="text-orange-500" />
                        <span className="font-semibold">Thư mục mới</span>
                    </button>
                </div>

                {/* Updated Glow Logic: Show intense glow AND KEEP SCALE when menu is open */}
                <button 
                    className={`w-18 h-18 md:w-20 md:h-20 rounded-full flex items-center justify-center transition-all duration-300 active:scale-95 bg-yellow-400 text-white 
                    ${showCreateMenu ? 'shadow-[0_0_30px_rgba(250,204,21,0.6)] scale-105' : 'shadow-2xl shadow-yellow-500/20 hover:shadow-[0_0_30px_rgba(250,204,21,0.7)] hover:scale-105'}`}
                >
                    <Plus size={36} strokeWidth={2.5} className="transition-transform duration-300" />
                </button>
            </div>
        )}

      {/* MODAL for Create/Edit Folder */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-3xl w-full max-w-md p-8 animate-in fade-in zoom-in duration-200 shadow-2xl">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold text-gray-900">
                {editingFolderId ? 'Sửa thư mục' : 'Thư mục mới'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-gray-600 p-2 rounded-full hover:bg-gray-100">
                <X size={24} />
              </button>
            </div>
            
            <div className="space-y-8">
              {/* Name Input */}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-3 uppercase tracking-wider">Tên thư mục</label>
                <input 
                  type="text" 
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="Ví dụ: Du lịch, Ý tưởng..."
                  className="w-full px-5 py-4 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-lg"
                  autoFocus
                />
              </div>

              {/* Color Picker with Gradient Preview */}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-3 uppercase tracking-wider">Màu sắc</label>
                <div className="grid grid-cols-7 gap-3">
                  {COLOR_OPTIONS.map((color) => {
                    const colorName = color.id;
                    const toColorClass = GRADIENT_MAP[colorName];
                    return (
                        <button
                        key={color.id}
                        onClick={() => setSelectedColor(color.class)}
                        className={`w-full aspect-square rounded-full bg-gradient-to-b from-[#f1f1f1] ${toColorClass} transition-transform hover:scale-110 border-2 ${selectedColor === color.class ? 'border-gray-400 scale-110' : 'border-transparent'}`}
                        title={colorName}
                        />
                    );
                  })}
                </div>
              </div>

              {/* Icon Picker */}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-3 uppercase tracking-wider">Biểu tượng</label>
                <div className="grid grid-cols-5 gap-3">
                  {Object.entries(ICON_MAP).map(([name, Icon]) => (
                    <button
                      key={name}
                      onClick={() => setSelectedIcon(name)}
                      className={`p-3 rounded-2xl flex items-center justify-center transition-all ${selectedIcon === name ? 'bg-gray-100 text-gray-900 ring-2 ring-gray-200' : 'text-gray-400 hover:bg-gray-50'}`}
                    >
                      <Icon size={24} strokeWidth={2} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-10">
              <div className="flex-1"></div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="px-6 py-4 rounded-xl text-gray-600 hover:bg-gray-100 font-bold transition-colors"
              >
                Hủy
              </button>
              <button 
                onClick={handleSave}
                disabled={!folderName.trim()}
                className="px-8 py-4 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingFolderId ? 'Lưu thay đổi' : 'Tạo thư mục'}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
};