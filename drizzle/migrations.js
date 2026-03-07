import journal from './meta/_journal.json';
import m0000 from './0000_acoustic_medusa.sql';
import m0001 from './0001_chunks_fts.sql';

  export default {
    journal,
    migrations: {
      m0000,
      m0001
    }
  }
  
