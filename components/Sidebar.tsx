import React, { useMemo } from 'react';
import { Note } from '../types';
import { Search, Trash2, Feather } from 'lucide-react';

interface SidebarProps {
  notes: Note[];
  activeNoteId: string | null;
  onSelectNote: (id: string) => void;
  onDeleteNote: (id: string, e: React.MouseEvent) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onGoHome: () => void;
  currentView: 'dashboard' | 'trash';
}

export const Sidebar: React.FC<SidebarProps> = ({
  notes,
  activeNoteId,
  onSelectNote,
  onDeleteNote,
  searchQuery,
  onSearchChange,
  onGoHome,
  currentView
}) => {
  
  const sortedAndFilteredNotes = useMemo(() => {
    return notes
      .filter((note) => {
        const query = searchQuery.toLowerCase();
        return (
          note.title.toLowerCase().includes(query) ||
          note.content.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, searchQuery]);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    if (isToday) {
        return new Intl.DateTimeFormat('vi-VN', {
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }
    
    return new Intl.DateTimeFormat('vi-VN', {
      month: 'numeric',
      day: 'numeric',
    }).format(date);
  };

  return (
    <div className="w-full md:w-80 bg-[#F2F2F7] border-r border-gray-200/60 flex flex-col h-full">
      {/* Header */}
      <div className="px-5 pt-6 pb-2 bg-[#F2F2F7] sticky top-0 z-10">
        <div className="flex justify-between items-center mb-4">
           {/* Title Left */}
           <h1 className="text-xl font-bold text-gray-900 tracking-tight">
               {currentView === 'trash' ? 'Thùng rác' : 'Ghi chú'}
           </h1>

           {/* Home Button Right - Flat Feather Icon, Larger, No Border/Shadow */}
           <button 
             onClick={onGoHome}
             className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 ${
                currentView === 'dashboard' && activeNoteId === null 
                ? 'bg-white text-gray-900' // No shadow, no ring
                : 'text-gray-400 hover:bg-white/40 hover:text-gray-600' // Soft subtle hover
             }`}
             title="Trang chủ"
           >
               <Feather size={24} strokeWidth={2} />
           </button>
        </div>
      </div>

      {/* Note List */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-4">
        {sortedAndFilteredNotes.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            <p className="text-sm">
                {currentView === 'trash' ? 'Thùng rác trống' : 'Không tìm thấy ghi chú nào.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sortedAndFilteredNotes.map((note) => (
              <li
                key={note.id}
                onClick={() => onSelectNote(note.id)}
                className={`group relative cursor-pointer p-4 rounded-2xl transition-all duration-200 ${
                  activeNoteId === note.id 
                    ? 'bg-white shadow-sm ring-1 ring-black/5 z-10' 
                    : 'hover:bg-white/60'
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <h3 className={`font-bold text-[15px] truncate pr-6 ${activeNoteId === note.id ? 'text-gray-900' : 'text-gray-800'}`}>
                    {note.title.trim() || 'Ghi chú chưa đặt tên'}
                  </h3>
                   <button
                     onClick={(e) => onDeleteNote(note.id, e)}
                     className="absolute top-4 right-4 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all p-1 hover:bg-gray-100 rounded-full"
                     title={currentView === 'trash' ? "Xóa vĩnh viễn" : "Xóa ghi chú"}
                   >
                     <Trash2 size={14} />
                   </button>
                </div>
                <div className="flex gap-2 text-xs items-center">
                  <span className={`flex-shrink-0 font-medium ${activeNoteId === note.id ? 'text-gray-500' : 'text-gray-500'}`}>
                      {formatDate(note.updatedAt)}
                  </span>
                  <span className="truncate text-gray-400 leading-relaxed font-medium">
                    {note.content.replace(/\n/g, ' ').trim() || 'Chưa có nội dung'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Search Bar - Moved to Bottom, Fully Rounded */}
      <div className="p-4 bg-[#F2F2F7] border-t border-gray-200/50 z-10">
        <div className="relative group">
          <Search className="absolute left-4 top-3 text-gray-400 group-focus-within:text-gray-600 transition-colors" size={18} />
          <input
            type="text"
            placeholder="Tìm kiếm"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-11 pr-4 py-2.5 bg-[#E3E3E8] focus:bg-white border-none focus:ring-0 rounded-full text-[15px] transition-all outline-none text-gray-800 placeholder-gray-500"
          />
        </div>
      </div>
    </div>
  );
};