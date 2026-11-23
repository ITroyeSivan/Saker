function ChatIcon(props) {
  var paths={direction:'M4 6h12M4 12h8M4 18h4',module:'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',users:'M14 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.87M16 2.13a4 4 0 0 1 0 7.75',chat:'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9H13a8.48 8.48 0 0 1 8 8v.5',prompt:'M4 4h16v16H4zM8 8h8M8 12h8M8 16h4',settings:'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4',more:'M5 12h.01M12 12h.01M19 12h.01',flow:'M4 5h6v4H4zM14 5h6v4h-6zM9 15h6v4H9zM7 9v3h10V9M12 12v3',globe:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3',code:'M9 18l-6-6 6-6M15 6l6 6-6 6',flag:'M5 21V4M5 5h11l-1.5 4L16 13H5'};
  return React.createElement('svg',{width:14,height:14,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},React.createElement('path',{d:paths[props.name]||paths.settings}));
}

// 工作台导航语义图标。品牌图形只用于 Saker 标识，功能项不再全部复用猎隼。
function SakerNavIcon(props) {
  var name = props && props.name || 'dashboard';
  var size = (props && props.size) || 16;
  var paths = {
    dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
    tasks: 'M4 5h16M4 12h10M4 19h7M16 15l2 2 4-4',
    findings: 'M12 3 2 21h20L12 3zM12 9v5M12 17h.01',
    traffic: 'M3 12h4l3-7 4 14 3-7h4',
    assets: 'M4 7 12 3l8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
    modules: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    roles: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-1a7 7 0 0 1 14 0v1',
    capabilities: 'M4 7h16v10H4zM8 21h8M12 17v4M7 11h3M14 11h3',
    attention: 'M12 3a7 7 0 0 0-7 7v4l-2 4h18l-2-4V10a7 7 0 0 0-7-7M9 21h6',
    logs: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
    knowledge: 'M4 5a3 3 0 0 1 3-2h5v18H7a3 3 0 0 1-3-3zM20 5a3 3 0 0 0-3-2h-5v18h5a3 3 0 0 0 3-3z',
    conversation: 'M4 5h16v11H9l-5 4z',
    collapse: 'M15 6l-6 6 6 6',
    expand: 'M9 6l6 6-6 6',
  };
  return React.createElement('svg',{'data-saker-nav-icon':name,width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},React.createElement('path',{d:paths[name]||paths.dashboard}));
}
