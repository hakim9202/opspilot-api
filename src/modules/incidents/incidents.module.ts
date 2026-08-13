import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { AiSuggestionService } from './ai-suggestion.service';
import { ClusterPrefillService } from './cluster-prefill.service';

@Module({
  controllers: [IncidentsController],
  providers: [IncidentsService, AiSuggestionService, ClusterPrefillService],
  exports: [IncidentsService, AiSuggestionService, ClusterPrefillService],
})
export class IncidentsModule {}
